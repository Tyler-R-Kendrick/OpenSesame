//! NATS `JetStream` adapter behind [`TaskBus`].
//!
//! Stream subjects: `opensesame.events.>`; durable pull consumers per role
//! (`opensesame-worker`, `opensesame-backup`, ...). The native auth-callout
//! protocol runs on the server's `$SYS.REQ.USER.AUTH` subject in the AUTH
//! account (see `ops/nats/secure-client.conf`) — it is not a subject under
//! this stream, and `opensesame.callout.>` (crate constant) is only a
//! reserved application prefix, never the callout wire.
//!
//! Provisioning is separate from use: only `provision: true` (the
//! `Provisioner` role, a one-time operator action) may create the stream or
//! a consumer. Runtime roles look their consumer up and fail with
//! [`NatsBusError::NotProvisioned`] when it is absent.

use crate::nats_connect::{connect_options, BusHealth, InjectedMaterial, NatsRole};
use crate::nats_delivery::{
    consumer_config, converge_consumer, converge_stream, decode_or_terminate, publish_message,
    settle_batch, stream_config, Redelivery, StreamLimits,
};
use crate::nats_policy::NatsTransportView;
use crate::nats_transport::NatsTransportSpec;
use crate::process::{EventHandler, ProcessReport};
use crate::{
    BusEvent, TaskBus, DEFAULT_CONSUMER_NAME, DEFAULT_STREAM_NAME, DEFAULT_SUBJECT_PREFIX,
};
use async_nats::jetstream::{self, consumer::pull};
use async_trait::async_trait;
use futures::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// Adapter-level failures with stable codes.
#[derive(Debug, thiserror::Error)]
pub enum NatsBusError {
    #[error("not_provisioned: stream {stream} / consumer {consumer} absent; run the provisioning action")]
    NotProvisioned { stream: String, consumer: String },
    #[error("role_cannot_consume: {0:?} holds no consumer")]
    RoleCannotConsume(NatsRole),
    #[error("role_cannot_publish: {0:?} does not publish")]
    RoleCannotPublish(NatsRole),
}

#[derive(Clone, Debug)]
pub struct NatsJetStreamConfig {
    pub nats_url: String,
    pub stream_name: String,
    pub subject_prefix: String,
    pub consumer_name: String,
    /// Optional `JetStream` filter (e.g. `opensesame.events.system.backup.>`).
    /// When unset, defaults to `{subject_prefix}.>`.
    pub filter_subject: Option<String>,
    /// How long a pull fetch waits when the stream is idle.
    pub fetch_expires: Duration,
    /// Transport policy + deployment references (never material).
    pub transport: NatsTransportSpec,
    pub role: NatsRole,
    /// Create the stream/consumer when absent, or fill in the `limits` /
    /// `redelivery` bounds an older release left unset (never overriding an
    /// operator's). Only the provisioning action and the legacy plaintext
    /// loopback profile set this.
    pub provision: bool,
    /// Retention the provisioning action gives the stream.
    pub limits: StreamLimits,
    /// Redelivery bounds for the durable consumer and failed handlers.
    pub redelivery: Redelivery,
}

impl Default for NatsJetStreamConfig {
    fn default() -> Self {
        Self {
            nats_url: "nats://127.0.0.1:4222".into(),
            stream_name: DEFAULT_STREAM_NAME.into(),
            subject_prefix: DEFAULT_SUBJECT_PREFIX.into(),
            consumer_name: DEFAULT_CONSUMER_NAME.into(),
            filter_subject: None,
            fetch_expires: Duration::from_secs(1),
            transport: NatsTransportSpec::plaintext(),
            role: NatsRole::Host,
            provision: true,
            limits: StreamLimits::default(),
            redelivery: Redelivery::default(),
        }
    }
}

impl NatsJetStreamConfig {
    fn stream_subjects(&self) -> String {
        format!("{}.>", self.subject_prefix.trim_end_matches('.'))
    }

    fn subject_filter(&self) -> String {
        self.filter_subject
            .clone()
            .unwrap_or_else(|| self.stream_subjects())
    }
}

struct Session {
    client: async_nats::Client,
    js: jetstream::Context,
    consumer: Option<jetstream::consumer::Consumer<pull::Config>>,
}

/// `JetStream` `TaskBus`: publish `CloudEvents`; drain via durable pull consumer.
pub struct NatsJetStreamTaskBus {
    config: NatsJetStreamConfig,
    session: RwLock<Session>,
    health: Arc<BusHealth>,
    injected: InjectedMaterial,
}

async fn open_session(
    config: &NatsJetStreamConfig,
    injected: &InjectedMaterial,
    health: Arc<BusHealth>,
) -> anyhow::Result<Session> {
    crate::validate_nats_url(&config.nats_url).map_err(|e| anyhow::anyhow!("{e}"))?;
    let spec = config.transport.clone().normalized(&config.nats_url)?;
    let options = connect_options(&spec, config.role, injected, health).await?;
    let client = options.connect(config.nats_url.as_str()).await?;
    let js = jetstream::new(client.clone());

    let consumer = if !config.role.consumes() {
        None
    } else if config.provision {
        Some(provision(&js, config).await?)
    } else {
        // `$JS.API.CONSUMER.INFO.<stream>.<consumer>` only: no stream info,
        // no create. Absent → not_provisioned, never a create.
        match js
            .get_consumer_from_stream::<pull::Config, _, _>(
                &config.consumer_name,
                &config.stream_name,
            )
            .await
        {
            Ok(consumer) => Some(consumer),
            Err(error)
                if matches!(
                    error.kind(),
                    jetstream::stream::ConsumerErrorKind::JetStream(_)
                ) =>
            {
                return Err(NatsBusError::NotProvisioned {
                    stream: config.stream_name.clone(),
                    consumer: config.consumer_name.clone(),
                }
                .into());
            }
            Err(error) => return Err(error.into()),
        }
    };
    Ok(Session {
        client,
        js,
        consumer,
    })
}

/// Create the stream and durable when missing. When they exist, fill in only
/// what an older release left unbounded ([`converge_stream`],
/// [`converge_consumer`]); what an operator tuned is never overwritten.
async fn provision(
    js: &jetstream::Context,
    config: &NatsJetStreamConfig,
) -> anyhow::Result<jetstream::consumer::Consumer<pull::Config>> {
    let mut stream = js
        .get_or_create_stream(stream_config(
            &config.stream_name,
            config.stream_subjects(),
            &config.limits,
        ))
        .await?;
    if let Some(next) = converge_stream(&stream.info().await?.config, &config.limits) {
        tracing::info!(stream = %config.stream_name, "bounding a stream an older release left unlimited");
        js.update_stream(next).await?;
    }
    let consumer = stream
        .get_or_create_consumer(
            &config.consumer_name,
            consumer_config(
                &config.consumer_name,
                config.subject_filter(),
                &config.redelivery,
            ),
        )
        .await?;
    match converge_consumer(&consumer.cached_info().config, &config.redelivery) {
        Some(next) => {
            tracing::info!(consumer = %config.consumer_name, "bounding redelivery a durable left unlimited");
            Ok(stream.create_consumer(next).await?)
        }
        None => Ok(consumer),
    }
}

impl NatsJetStreamTaskBus {
    /// Connect with material from the deployment plane.
    ///
    /// # Errors
    ///
    /// A policy the profile cannot honour, missing or invalid material, a
    /// refused handshake, or an unprovisioned consumer. Never a plaintext
    /// or in-memory fallback.
    pub async fn connect(config: NatsJetStreamConfig) -> anyhow::Result<Self> {
        Self::connect_with(config, InjectedMaterial::default()).await
    }

    /// [`Self::connect`] with caller-held material (managed certificate,
    /// SPIFFE SVID) standing in for what the env resolver cannot load.
    ///
    /// # Errors
    ///
    /// As [`Self::connect`].
    pub async fn connect_with(
        config: NatsJetStreamConfig,
        injected: InjectedMaterial,
    ) -> anyhow::Result<Self> {
        let health = Arc::new(BusHealth::default());
        let session = open_session(&config, &injected, Arc::clone(&health)).await?;
        Ok(Self {
            config,
            session: RwLock::new(session),
            health,
            injected,
        })
    }

    /// Rotate to new transport material: open a second connection with
    /// `transport` (and optionally new injected material), swap it in, then
    /// drain the old one. The durable consumer is untouched — it is looked
    /// up again, never recreated, so its name and sequence survive.
    ///
    /// # Errors
    ///
    /// As [`Self::connect`]; on error the old session stays in place.
    pub async fn rotate(
        &self,
        transport: NatsTransportSpec,
        injected: Option<InjectedMaterial>,
    ) -> anyhow::Result<()> {
        let mut config = self.config.clone();
        config.transport = transport;
        config.provision = false;
        let injected = injected.unwrap_or_else(|| self.injected.clone());
        let fresh = open_session(&config, &injected, Arc::clone(&self.health)).await?;
        let old = {
            let mut guard = self.session.write().await;
            std::mem::replace(&mut *guard, fresh)
        };
        if let Err(error) = old.client.drain().await {
            tracing::warn!(%error, "draining the previous NATS connection failed");
        }
        Ok(())
    }

    /// Durable consumer info (name, delivered/ack floors), for lifecycle tests.
    ///
    /// # Errors
    ///
    /// When the role holds no consumer or the server refuses `CONSUMER.INFO`.
    pub async fn consumer_info(&self) -> anyhow::Result<jetstream::consumer::Info> {
        let mut guard = self.session.write().await;
        let consumer = guard
            .consumer
            .as_mut()
            .ok_or(NatsBusError::RoleCannotConsume(self.config.role))?;
        Ok(consumer
            .info()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .clone())
    }

    #[must_use]
    pub fn health(&self) -> Arc<BusHealth> {
        Arc::clone(&self.health)
    }

    #[must_use]
    pub fn transport_view(&self) -> NatsTransportView {
        self.config.transport.view()
    }

    #[must_use]
    pub fn role(&self) -> NatsRole {
        self.config.role
    }

    /// The live client's server id, for topology tests.
    pub async fn server_id(&self) -> String {
        self.session.read().await.client.server_info().server_id
    }
}

#[async_trait]
impl TaskBus for NatsJetStreamTaskBus {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()> {
        if !self.config.role.publishes() {
            return Err(NatsBusError::RoleCannotPublish(self.config.role).into());
        }
        let subject = event.subject(&self.config.subject_prefix);
        let message = publish_message(&event, &self.config.stream_name)?;
        let session = self.session.read().await;
        let ack = session.js.send_publish(subject, message).await?.await?;
        if ack.duplicate {
            tracing::debug!(event_id = %event.id, "TaskBus publish deduplicated by Nats-Msg-Id");
        }
        Ok(())
    }

    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>> {
        if max == 0 {
            return Ok(Vec::new());
        }
        let session = self.session.read().await;
        let consumer = session
            .consumer
            .as_ref()
            .ok_or(NatsBusError::RoleCannotConsume(self.config.role))?;
        let mut batch = consumer
            .fetch()
            .max_messages(max)
            .expires(self.config.fetch_expires)
            .messages()
            .await?;

        let mut out = Vec::with_capacity(max);
        while let Some(msg) = batch.next().await {
            let msg = msg.map_err(|e| anyhow::anyhow!("{e}"))?;
            // Envelope validation only: the payload's own claims (a
            // `principal_id`, an `organization_id`) never widen what this
            // consumer may do — scope belongs to the caller's authority.
            let Some(event) = decode_or_terminate(&msg, &self.config.redelivery).await? else {
                continue;
            };
            msg.ack().await.map_err(|e| anyhow::anyhow!("{e}"))?;
            out.push(event);
            if out.len() >= max {
                break;
            }
        }
        Ok(out)
    }

    async fn process(
        &self,
        max: usize,
        handler: &dyn EventHandler,
    ) -> anyhow::Result<ProcessReport> {
        let session = self.session.read().await;
        let consumer = session
            .consumer
            .as_ref()
            .ok_or(NatsBusError::RoleCannotConsume(self.config.role))?;
        settle_batch(consumer, max, &self.config, handler).await
    }
}

#[cfg(test)]
#[path = "nats_tests.rs"]
mod tests;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_harness.rs"]
pub(crate) mod live_harness;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_tests.rs"]
pub(crate) mod live_tests;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_roles.rs"]
mod live_roles;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_topology.rs"]
pub(crate) mod live_topology;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_routes.rs"]
mod live_routes;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_callout.rs"]
pub(crate) mod live_callout;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_mixed.rs"]
mod live_mixed;

#[cfg(all(test, feature = "live-tests"))]
#[path = "nats_live_delivery.rs"]
mod live_delivery;
