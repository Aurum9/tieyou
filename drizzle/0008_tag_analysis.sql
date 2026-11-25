ALTER TABLE tag_label_overrides ADD COLUMN include_in_analysis INTEGER NOT NULL DEFAULT 1 CHECK (include_in_analysis IN (0, 1));
