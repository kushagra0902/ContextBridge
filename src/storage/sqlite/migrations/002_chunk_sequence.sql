ALTER TABLE chunks
ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0);

CREATE INDEX chunks_session_sequence_idx ON chunks(session_id, sequence, chunk_id);
