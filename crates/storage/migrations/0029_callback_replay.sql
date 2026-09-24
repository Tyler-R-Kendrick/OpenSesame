CREATE TABLE callback_edge_deliveries (
  connection_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, delivery_id)
);
CREATE INDEX callback_edge_delivery_expiry ON callback_edge_deliveries(expires_at);
