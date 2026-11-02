-- Migration: 20261102000001_dashboard_financial_metrics.sql
-- Description: Expand get_admin_dashboard_metrics RPC with total deposited and order revenue

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orders_count bigint;
  v_customers_count bigint;
  v_wallet_liabilities numeric;
  v_total_deposited_minor numeric;
  v_paid_count bigint;
  v_paid_revenue_minor numeric;
  v_active_count bigint;
  v_result jsonb;
BEGIN
  -- Restrict to service_role (invoked via createSupabaseAdminClient server-side)
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING errcode = '42501';
  END IF;

  SELECT count(*) INTO v_orders_count FROM public.orders;
  SELECT count(*) INTO v_customers_count FROM public.profiles;

  -- Total unspent wallet liability in GHS
  SELECT coalesce(sum(balance_minor), 0)
    INTO v_wallet_liabilities
    FROM public.wallets
   WHERE currency = 'GHS';

  -- Total completed deposits in GHS (all money brought in via Paystack/gateway)
  SELECT coalesce(sum(amount_minor), 0)
    INTO v_total_deposited_minor
    FROM public.wallet_transactions
   WHERE type = 'DEPOSIT' AND status = 'COMPLETED' AND currency = 'GHS';

  -- Total paid order revenue in GHS
  SELECT count(*), coalesce(sum(round(total * 100)), 0)
    INTO v_paid_count, v_paid_revenue_minor
    FROM public.orders
   WHERE payment_status = 'PAID' AND currency = 'GHS';

  SELECT count(*) INTO v_active_count
    FROM public.orders
   WHERE fulfillment_status IN ('PROCESSING', 'SUBMITTING', 'SUBMITTED');

  SELECT jsonb_build_object(
    'orders_count', v_orders_count,
    'customers_count', v_customers_count,
    'ghs_balance_minor', v_wallet_liabilities,
    'total_deposited_minor', v_total_deposited_minor,
    'paid_revenue_minor', v_paid_revenue_minor,
    'paid_orders_count', v_paid_count,
    'active_orders_count', v_active_count,
    'catalog_service_count', (
      SELECT count(*)
        FROM public.provider_catalog_services
       WHERE provider = 'reliablesmm'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_metrics() FROM public;
REVOKE ALL ON FUNCTION public.get_admin_dashboard_metrics() FROM anon;
REVOKE ALL ON FUNCTION public.get_admin_dashboard_metrics() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_metrics() TO service_role;
