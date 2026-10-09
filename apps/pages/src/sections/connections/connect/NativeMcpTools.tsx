/** Tool names come from this verified MCP server; the driver validates its actual input schema. */
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconSearch } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { NativeConnectorActions } from "./NativeConnectorActions.js";
import { nativeMcpArgumentGuide } from "./NativeMcpArgumentGuide.js";
import type {
  NativeActionDescriptor,
  NativeConnectorCallbacks,
  NativeConnectorController,
  SafeActionResult,
} from "./native-connector-ui.js";

function toolAction(
  tool: SafeActionResult["items"][number],
): NativeActionDescriptor {
  const guide = nativeMcpArgumentGuide(tool.inputSchema);
  return {
    id: `mcp.tool:${tool.id}`,
    label: `${tool.id}: ${tool.label}`,
    available: guide !== null,
    reason: "This server did not advertise a displayable argument schema.",
    inputSchema: guide?.schema,
    fields: [
      {
        id: "arguments",
        label: "Tool arguments (JSON object)",
        kind: "textarea",
        secret: false,
        required: true,
        defaultValue: "{}",
        help: "Use the required fields and types in the advertised argument schema. The schema is checked before sending this request.",
      },
    ],
    resultOrigins: [],
  };
}

export function NativeMcpTools({
  view,
  controller,
  onChanged,
  onFlash,
}: NativeConnectorCallbacks & {
  view: NativeConnectorView;
  controller: NativeConnectorController;
}) {
  const [discovery, setDiscovery] = useState<SafeActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  async function discover() {
    if (busy || view.status !== "connected") return;
    setBusy(true);
    setFailure("");
    try {
      setDiscovery(await controller.invoke("mcp.tools.list", {}));
    } catch (error) {
      const text = errorText(error);
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      setBusy(false);
      onChanged(controller.load());
    }
  }
  return (
    <section className="panel" aria-label="MCP tools">
      <div className="panel__head">
        <h2>Provider tools</h2>
        <StatusMark
          tone="warn"
          label="Tools may change provider data. Review the advertised tool description before running it."
        />
      </div>
      <div className="panel__body cx-form">
        <IconKey
          label="Discover MCP tools"
          disabled={busy || view.status !== "connected"}
          onClick={() => void discover()}
        >
          <IconSearch size={16} />
        </IconKey>
        {failure ? <StatusMark tone="err" label={failure} /> : null}
        {discovery ? (
          <>
            <p>
              {discovery.label} · {discovery.items.length} tools
            </p>
            <NativeConnectorActions
              controller={controller}
              view={view}
              disabled={busy}
              onChanged={onChanged}
              onFlash={onFlash}
              descriptor={{
                providerId: view.providerId,
                name: discovery.label,
                docsUrl: null,
                methods: [],
                actions: discovery.items.map(toolAction),
              }}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
