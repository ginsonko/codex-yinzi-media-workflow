-- Pin the image service type and configuration used by a production image action.
ALTER TABLE image_generations ADD COLUMN image_service_type TEXT;
ALTER TABLE image_generations ADD COLUMN image_config_id INTEGER;
