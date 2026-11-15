-- ==========================================================
-- Triggers and Functions for Schema V2
-- ==========================================================
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION slugify(t TEXT) RETURNS TEXT AS $$
    SELECT trim(both '-' from regexp_replace(lower(unaccent(t)), '[^a-z0-9]+', '-', 'g'));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION user_status_change() RETURNS trigger AS $$
BEGIN
    IF OLD.is_active AND NOT NEW.is_active THEN
        NEW.banned_at := now();
    ELSIF NOT OLD.is_active AND NEW.is_active THEN
        NEW.banned_at := NULL;
        NEW.banned_reason := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_users_status ON users;
CREATE TRIGGER trg_users_status BEFORE UPDATE OF is_active ON users
    FOR EACH ROW EXECUTE FUNCTION user_status_change();

CREATE OR REPLACE FUNCTION set_room_slug() RETURNS trigger AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := left(slugify(NEW.title), 200) || '-' || NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rooms_slug ON rooms;
CREATE TRIGGER trg_rooms_slug BEFORE INSERT ON rooms
    FOR EACH ROW EXECUTE FUNCTION set_room_slug();

DROP TRIGGER IF EXISTS trg_rooms_updated ON rooms;
CREATE TRIGGER trg_rooms_updated BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION check_appointment_spam() RETURNS trigger AS $$
BEGIN
    NEW.guest_phone := regexp_replace(NEW.guest_phone, '^\+84', '0');

    PERFORM pg_advisory_xact_lock(hashtext('appt_phone:' || NEW.guest_phone));
    IF NEW.ip_address IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('appt_ip:' || host(NEW.ip_address)));
    END IF;

    IF EXISTS (SELECT 1 FROM spam_blocklist WHERE kind = 'phone' AND value = NEW.guest_phone)
       OR (NEW.ip_address IS NOT NULL AND EXISTS
           (SELECT 1 FROM spam_blocklist WHERE kind = 'ip' AND value = host(NEW.ip_address))) THEN
        RAISE EXCEPTION 'SPAM_BLOCKED' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.appointment_time <= now() OR NEW.appointment_time > now() + interval '30 days' THEN
        RAISE EXCEPTION 'INVALID_APPOINTMENT_TIME' USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (SELECT 1 FROM appointments
               WHERE guest_phone = NEW.guest_phone AND room_id = NEW.room_id
                 AND status IN ('pending', 'contacted')) THEN
        RAISE EXCEPTION 'DUPLICATE_APPOINTMENT' USING ERRCODE = 'P0001';
    END IF;

    IF (SELECT count(*) FROM appointments
        WHERE guest_phone = NEW.guest_phone AND created_at > now() - interval '24 hours') >= 3 THEN
        RAISE EXCEPTION 'RATE_LIMIT_PHONE' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.ip_address IS NOT NULL AND
       (SELECT count(*) FROM appointments
        WHERE ip_address = NEW.ip_address AND created_at > now() - interval '1 hour') >= 5 THEN
        RAISE EXCEPTION 'RATE_LIMIT_IP' USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM rooms
                   WHERE id = NEW.room_id AND status = 'available' AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'ROOM_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.ref_ctv_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM users WHERE id = NEW.ref_ctv_id AND role = 'ctv' AND is_active) THEN
        NEW.ref_ctv_id := NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appointments_spam ON appointments;
CREATE TRIGGER trg_appointments_spam BEFORE INSERT ON appointments
    FOR EACH ROW EXECUTE FUNCTION check_appointment_spam();

