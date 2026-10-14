import { NO_MODEL_PROVIDER } from "@opensesame/app-core/lib/model-provider.js";
import {
  inferenceSlugOptions,
  voiceSlugOptions,
} from "@opensesame/app-core/lib/model-slugs.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { ModelRoleSelects } from "../../src/sections/settings/AiModelRoles.js";

const meta = {
  title: "Controls/AI model choices",
  component: ModelRoleSelects,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "padded" },
  args: {
    record: NO_MODEL_PROVIDER,
    voiceOptions: voiceSlugOptions(true),
    inferenceOptions: inferenceSlugOptions({
      browserReady: true,
      connectedProviderIds: [],
    }),
    busy: false,
    onCommit: fn(),
  },
  render: function Choices(args) {
    const [record, setRecord] = useState(args.record);
    return (
      <ModelRoleSelects
        {...args}
        record={record}
        onCommit={(next) => {
          setRecord(next);
          args.onCommit(next);
        }}
      />
    );
  },
} satisfies Meta<typeof ModelRoleSelects>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {};
export const Saving: Story = { args: { busy: true } };
export const VoiceUnavailable: Story = { args: { voiceOptions: [] } };
