-- PayPal checkout, phase 1 (card / PayPal buttons on the quote page and in the portal): the new pay_method value.
-- Its own file on purpose: Postgres cannot use an enum value in the same transaction that added it, and the next
-- migration (20261021100100_us_paypal_checkout.sql) compares quotes.pay_method with it. Idempotent.
alter type public.pay_method add value if not exists 'paypal_checkout';
