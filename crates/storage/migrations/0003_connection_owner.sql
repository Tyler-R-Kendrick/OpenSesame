-- Who a connection belongs to. `owner_kind` says what sort of thing owns it but
-- never which one, so every authenticated caller on a gateway could reach every
-- connection in the org. Recorded here rather than in memory because the rows
-- outlive the process: an owner forgotten at restart would lock a principal out
-- of its own third-party grants for good.
-- Null for rows created before this column existed, and for connections created
-- by an operator on nobody's behalf; those stay operator-only.
ALTER TABLE connections ADD COLUMN owner_subject TEXT
