-- Seed data for Person Re-Identification Database
-- This file contains sample data for testing

-- Sample cameras with GPS locations
INSERT INTO cameras (id, name, location, latitude, longitude, altitude, pan_angle, tilt_angle, camera_height, camera_type, calibration_params)
VALUES
    ('cam_001', 'Main Entrance Camera', 'Building A - Main Entrance', 40.7128, -74.0060, 10.0, 180.0, -15.0, 3.0, 'fixed',
     '{"focal_length": 1000, "sensor_width": 1920, "sensor_height": 1080}'),
    ('cam_002', 'Parking Lot Camera', 'Parking Area North', 40.7130, -74.0058, 12.0, 270.0, -20.0, 5.0, 'ptz',
     '{"focal_length": 1200, "sensor_width": 1920, "sensor_height": 1080}'),
    ('cam_003', 'Street Camera', 'Street Corner', 40.7132, -74.0056, 8.0, 45.0, -10.0, 4.0, 'fixed',
     '{"focal_length": 800, "sensor_width": 1920, "sensor_height": 1080}')
ON CONFLICT (id) DO NOTHING;

-- Sample persons
INSERT INTO persons (external_id, display_name, metadata)
VALUES
    ('EMP001', 'John Doe', '{"department": "Security", "role": "Guard"}'),
    ('EMP002', 'Jane Smith', '{"department": "IT", "role": "Engineer"}'),
    ('VISITOR001', 'Visitor 1', '{"type": "visitor", "check_in": "2024-01-01T10:00:00Z"}')
ON CONFLICT (external_id) DO NOTHING;

-- Note: Actual sightings and traits will be populated by the system during runtime