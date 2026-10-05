ALTER TABLE outbox_events ADD COLUMN organization_id TEXT;
UPDATE outbox_events SET organization_id = json_extract(payload_json, '$.organization_id')
WHERE CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.organization_id') = 'text' ELSE 0 END;
UPDATE outbox_events SET organization_id = (
  SELECT organization_id FROM vaults WHERE id = json_extract(outbox_events.payload_json, '$.vault_id')
) WHERE organization_id IS NULL AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.vault_id') = 'text' ELSE 0 END;
