-- 23.10.2026 appointment manager: two booking statuses. Own file on purpose: a new enum value cannot be used in the same
-- transaction that adds it (the functions in the next migration only use it at run time).
--   rescheduled = the visit was moved by the customer; the new visit is a new row with rescheduled_from_id = this row
--   no_show     = the client marked in the portal that the customer was not there
-- 'confirmed' keeps its meaning (the booking stands); a customer's own confirmation is bookings.confirmed_at.
alter type public.booking_status add value if not exists 'rescheduled';
alter type public.booking_status add value if not exists 'no_show';
