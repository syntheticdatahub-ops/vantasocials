-- Migration Rollback: 20261102000001_dashboard_financial_metrics.rollback.sql
-- Description: Revert get_admin_dashboard_metrics RPC to original version

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orders_count bigint;
  v_customers_count bigint;
  v_wallet_liabilities jsonb;
  v_paid_count bigint;
  v_active_count bigint;
  v_result jsonb;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING errcode = '42501';
  END IF;

  SELECT count(*) INTO v_orders_count FROM public.orders;
  SELECT count(*) INTO v_customers_count FROM public.profiles;

  SELECT coalesce(sum(balance_minor), 0)
    INTO v_wallet_liabilities
    FROM public.wallets
   WHERE currency = 'GHS';

  SELECT count(*) INTO v_paid_count
    FROM public.orders
   WHERE payment_status = 'PAID';

  SELECT count(*) INTO v_active_count
    FROM public.orders
   WHERE fulfillment_status IN ('PROCESSING', 'SUBMITTING', 'SUBMITTED');

  SELECT jsonb_build_object(
    'orders_count', v_orders_count,
    'customers_count', v_customers_count,
    'ghs_balance_minor', coalesce(v_wallet_liabilities, '0'::jsonb),
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
