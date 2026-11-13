ALTER TABLE "canvas_session_health_events" DROP CONSTRAINT "canvas_session_health_events_kind_check";--> statement-breakpoint
ALTER TABLE "canvas_session_health_events" ADD CONSTRAINT "canvas_session_health_events_kind_check" CHECK ("kind" in ('keepalive', 'sync', 'restore-check', 'api', 'page-keepalive'));
