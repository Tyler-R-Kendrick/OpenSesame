use super::*;

pub(super) async fn resolve_invocation(
    st: &AppState,
    boot: &crate::app_state::Bootstrap,
    subject: &str,
    body: &InvokeBody,
    level: u8,
) -> Result<ResolvedInvocation, Response> {
    let default_ref = st
        .connection_ref
        .as_ref()
        .map_or_else(String::new, |connection| connection.handle.uri());
    let requested_ref = body
        .connection_ref
        .as_ref()
        .or(body.connection.as_ref())
        .unwrap_or(&default_ref);
    let classified = st
        .broker
        .db
        .classify_controlled_reference(&boot.org, requested_ref)
        .await
        .map_err(|_| {
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"controlled_reference_rejected"})),
            )
                .into_response()
        })?;
    match classified {
        opensesame_storage::credential_canaries::ControlledReferenceDecision::Reject => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error":"controlled_reference_rejected"})),
            )
                .into_response());
        }
        opensesame_storage::credential_canaries::ControlledReferenceDecision::ActiveAlias {
            connection_id,
            target_reference,
        } => {
            let mut resolved =
                delegated_invocation(st, boot, subject, &target_reference, level).await?;
            resolved.controlled_alias = Some(ControlledAliasAdmission {
                organization_id: boot.org,
                reference: requested_ref.clone(),
                connection_id,
                target_reference,
            });
            return Ok(resolved);
        }
        opensesame_storage::credential_canaries::ControlledReferenceDecision::Ordinary => {}
    }
    let logical_name = st
        .connection_ref
        .as_ref()
        .map_or("", |connection| connection.handle.logical_name.as_str());
    if [default_ref.as_str(), logical_name, ""].contains(&requested_ref.as_str()) {
        bootstrap_invocation(st, boot)
    } else {
        delegated_invocation(st, boot, subject, requested_ref, level).await
    }
}

/// Private original issuer binding survives permission awaits and queued dispatch.
pub(crate) struct ControlledAliasAdmission {
    organization_id: OrganizationId,
    reference: String,
    connection_id: ConnectionId,
    target_reference: String,
}
impl ControlledAliasAdmission {
    async fn assert_current(&self, st: &AppState) -> anyhow::Result<()> {
        let decision = st
            .broker
            .db
            .classify_controlled_reference(&self.organization_id, &self.reference)
            .await?;
        anyhow::ensure!(
            matches!(decision, opensesame_storage::credential_canaries::ControlledReferenceDecision::ActiveAlias { connection_id, target_reference } if connection_id == self.connection_id && target_reference == self.target_reference),
            "controlled alias authority retired"
        );
        Ok(())
    }
}
pub(super) async fn assert_alias_current(
    st: &AppState,
    resolved: &ResolvedInvocation,
) -> anyhow::Result<()> {
    if let Some(alias) = &resolved.controlled_alias {
        alias.assert_current(st).await?;
    }
    Ok(())
}

pub(crate) async fn execute_invocation(
    st: &AppState,
    organization_id: OrganizationId,
    resolved: &ResolvedInvocation,
    input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
) -> anyhow::Result<InvocationReceipt> {
    assert_alias_current(st, resolved).await?;
    let Some(network) = constrained_http else {
        let request = opensesame_broker::invoke_request(&input);
        let policy = input.connection_policy_id.clone();
        return st
            .broker
            .invoke_with(input, || async {
                assert_alias_current(st, resolved)
                    .await
                    .map_err(|e| HostError::Connector(e.to_string()))?;
                st.broker.host.invoke(&policy, &request)
            })
            .await;
    };
    let broker = st.connection_broker.clone();
    let connection_id = resolved.controlled_alias.as_ref().map_or_else(
        || resolved.connection_id.to_string(),
        |alias| alias.target_reference.clone(),
    );
    let operation = input.intent.operation.clone();
    st.broker
        .invoke_with(input, || async move {
            assert_alias_current(st, resolved)
                .await
                .map_err(|e| HostError::Connector(e.to_string()))?;
            broker
                .invoke_network_json(
                    &organization_id,
                    &connection_id,
                    &operation,
                    &network.method,
                    &network.url,
                    network.body,
                )
                .await
                .map(|safe_summary| InvokeResult {
                    ok: true,
                    safe_summary,
                    external_request_digest: None,
                })
                .map_err(|error| HostError::Connector(error.to_string()))
        })
        .await
}
