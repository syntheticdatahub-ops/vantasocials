import Link from "next/link";
import { requireAdmin } from "../../lib/admin/auth";
import { createSupabaseAdminClient } from "../../lib/supabase/server";
import { AdminQueryError } from "./AdminDataState";
import BalanceRefresh from "./providers/BalanceRefresh";

type DashboardMetricsResult = {
  customer_count?: number;
  order_count?: number;
  wallet_count?: number;
  ghs_balance_minor?: number;
  catalog_service_count?: number;
  customers_count?: number;
  orders_count?: number;
  paid_orders_count?: number;
  active_orders_count?: number;
};

type RecentOrderItem = {
  public_order_id: string;
  total: number | string;
  currency: string;
  payment_status: string;
  fulfillment_status: string;
  created_at: string;
  profiles: { email?: string } | null;
  services: { name?: string } | null;
};

export default async function AdminPage() {
  const { admin } = await requireAdmin();
  if (!admin) return null;
  const db = createSupabaseAdminClient();

  // 1. Attempt server-side aggregated metrics RPC first
  let rpcMetrics: DashboardMetricsResult | null = null;
  let rpcError: unknown = null;

  try {
    const { data, error } = await db.rpc("get_admin_dashboard_metrics");
    if (!error && data) {
      rpcMetrics = Array.isArray(data) ? (data[0] as DashboardMetricsResult) : (data as DashboardMetricsResult);
    } else {
      rpcError = error;
      if (error) {
        console.error("Admin dashboard RPC get_admin_dashboard_metrics() failed, falling back to individual queries:", error);
      }
    }
  } catch (err) {
    rpcError = err;
    console.error("Admin dashboard RPC get_admin_dashboard_metrics() threw an exception, falling back to individual queries:", err);
  }

  let customers: number | null = null;
  let orders: number | null = null;
  let walletCount: number | null = null;
  let ghsBalanceSample = 0;
  let totalDepositedGHS = 0;
  let totalRevenueGHS = 0;
  let catalogCount: number | null = null;

  let customersError: unknown = null;
  let ordersError: unknown = null;
  let walletsError: unknown = null;
  let financialError: unknown = null;
  let catalogError: unknown = null;

  let recent: RecentOrderItem[] = [];
  let recentError: unknown = null;

  let providerHealth: {
    configured: boolean;
    balance: number | string | null;
    balance_currency: string | null;
    last_balance_check: string | null;
    balance_status: string | null;
  } | null = null;
  let providerHealthError: unknown = null;

  if (rpcMetrics) {
    customers = rpcMetrics.customers_count ?? rpcMetrics.customer_count ?? null;
    orders = rpcMetrics.orders_count ?? rpcMetrics.order_count ?? null;
    walletCount = rpcMetrics.wallet_count ?? null;
    ghsBalanceSample = Number(rpcMetrics.ghs_balance_minor ?? 0);
    catalogCount = rpcMetrics.catalog_service_count ?? null;

    const [
      { data: recentOrders, error: rErr },
      { data: health, error: hErr },
      { data: depositTxs, error: depErr },
      { data: paidOrders, error: revErr }
    ] = await Promise.all([
      db.from("orders").select("public_order_id,total,currency,payment_status,fulfillment_status,created_at,profiles(email),services(name)").order("created_at", { ascending: false }).limit(10),
      db.from("provider_health").select("configured,balance,balance_currency,last_balance_check,balance_status").eq("provider", "reliablesmm").maybeSingle(),
      db.from("wallet_transactions").select("amount_minor").eq("type", "DEPOSIT").eq("status", "COMPLETED").eq("currency", "GHS"),
      db.from("orders").select("total").eq("payment_status", "PAID").eq("currency", "GHS"),
    ]);
    recent = (recentOrders ?? []) as unknown as RecentOrderItem[];
    recentError = rErr;
    providerHealth = health;
    providerHealthError = hErr;

    const totalDepMinor = (depositTxs ?? []).reduce((sum, t) => sum + Number(t.amount_minor ?? 0), 0);
    totalDepositedGHS = totalDepMinor / 100;
    totalRevenueGHS = (paidOrders ?? []).reduce((sum, o) => sum + Number(o.total ?? 0), 0);
    financialError = depErr || revErr;
  } else {
    // Fallback: bounded queries without pulling 1,000 raw wallets into memory
    const [
      { count: custCount, error: cErr },
      { count: ordCount, error: oErr },
      { data: wallets, count: wCount, error: wErr },
      { data: recentOrders, error: rErr },
      { data: health, error: hErr },
      { count: catCount, error: catErr },
      { data: depositTxs, error: depErr },
      { data: paidOrders, error: revErr }
    ] = await Promise.all([
      db.from("profiles").select("id", { count: "planned", head: true }),
      db.from("orders").select("id", { count: "planned", head: true }),
      db.from("wallets").select("balance_minor,currency", { count: "planned" }).eq("currency", "GHS").limit(100),
      db.from("orders").select("public_order_id,total,currency,payment_status,fulfillment_status,created_at,profiles(email),services(name)").order("created_at", { ascending: false }).limit(10),
      db.from("provider_health").select("configured,balance,balance_currency,last_balance_check,balance_status").eq("provider", "reliablesmm").maybeSingle(),
      db.from("provider_catalog_services").select("id", { count: "planned", head: true }).eq("provider", "reliablesmm"),
      db.from("wallet_transactions").select("amount_minor").eq("type", "DEPOSIT").eq("status", "COMPLETED").eq("currency", "GHS"),
      db.from("orders").select("total").eq("payment_status", "PAID").eq("currency", "GHS")
    ]);
    customers = custCount;
    orders = ordCount;
    walletCount = wCount;
    ghsBalanceSample = (wallets ?? []).reduce((sum, w) => sum + Number(w.balance_minor ?? 0), 0);
    catalogCount = catCount;
    recent = (recentOrders ?? []) as unknown as RecentOrderItem[];
    providerHealth = health;

    const totalDepMinor = (depositTxs ?? []).reduce((sum, t) => sum + Number(t.amount_minor ?? 0), 0);
    totalDepositedGHS = totalDepMinor / 100;
    totalRevenueGHS = (paidOrders ?? []).reduce((sum, o) => sum + Number(o.total ?? 0), 0);

    customersError = cErr;
    ordersError = oErr;
    walletsError = wErr;
    financialError = depErr || revErr;
    recentError = rErr;
    providerHealthError = hErr;
    catalogError = catErr;
  }

  const computedAt = new Date().toUTCString();
  const walletSampleComplete = walletCount !== null && (rpcMetrics ? true : walletCount <= 100);

  // Format provider balance nicely (e.g. 0.00 USD if near zero)
  const formatProviderBalance = (val: number | string | null | undefined, currency: string | null) => {
    if (val === null || val === undefined) return "—";
    const num = Number(val);
    if (!Number.isNaN(num)) {
      return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency ?? "USD"}`;
    }
    return `${val} ${currency ?? "USD"}`;
  };

  return (
    <div className="admin-overview">
      <header className="admin-overview-header">
        <div>
          <p className="dashboard-kicker">
            OPERATIONS · Metrics computed at {computedAt} ({rpcMetrics ? "aggregated RPC" : "direct fallback queries"})
          </p>
          <h1>WELCOME BACK PLAY.ATO</h1>
          <p>Monitor VANTA operations and manage activity in real time.</p>
        </div>
        <span className="admin-live-badge">{[customersError, ordersError, walletsError, financialError, recentError, providerHealthError, catalogError, rpcError].some(Boolean) && !rpcMetrics ? "● Some data unavailable" : "● Live data"}</span>
        <div className="admin-overview-mark" aria-hidden="true">V</div>
      </header>

      <div className="admin-summary-layout">
        <div className="admin-side-stats">
          <article className="admin-kpi-card">
            <span>Total orders</span>
            {ordersError ? <AdminQueryError message="Order count unavailable." /> : <strong>{orders ?? "Unavailable"}</strong>}
            <small>All time orders</small>
          </article>
          <article className="admin-kpi-card">
            <span>Customers</span>
            {customersError ? <AdminQueryError message="Customer count unavailable." /> : <strong>{customers ?? "Unavailable"}</strong>}
            <small>Registered users</small>
          </article>
        </div>
        <article className="admin-wallet-focus">
          <span>Total Money Processed (Deposits)</span>
          {financialError ? <AdminQueryError message="Financial balance unavailable." /> : (
            <>
              <strong>{totalDepositedGHS.toFixed(2)} <em>GHS</em></strong>
              <small>All-time payments deposited into VANTA via payment gateway</small>

              <div className="admin-wallet-financial-breakdown">
                <div className="admin-wallet-financial-item">
                  <span>Paid Orders (Revenue)</span>
                  <strong>{totalRevenueGHS.toFixed(2)} <em>GHS</em></strong>
                  <small>Spent on fulfilled/active orders</small>
                </div>
                <div className="admin-wallet-financial-item">
                  <span>Current Wallet Liability</span>
                  <strong>{(ghsBalanceSample / 100).toFixed(2)} <em>GHS</em></strong>
                  <small>{rpcMetrics ? `Unspent across all ${walletCount ?? 0} wallets` : (walletSampleComplete ? `Unspent across all ${walletCount ?? 0} wallets` : `Unspent sample balance`)}</small>
                </div>
              </div>
            </>
          )}
          <div className="admin-wallet-orbit" aria-hidden="true" />
        </article>
      </div>

      <div className="admin-overview-columns">
        <section className="admin-recent-panel">
          <div className="admin-panel-heading">
            <div>
              <h2>Recent orders</h2>
              <p>Latest customer activity across VANTA.</p>
            </div>
            <Link prefetch={false} href="/admin/orders">View all →</Link>
          </div>
          {recentError ? <AdminQueryError message="Recent orders could not be loaded." /> : recent.length === 0 ? (
            <div className="admin-empty">
              <div className="empty-icon">V</div>
              <h3>No orders yet</h3>
              <p>New customer orders will appear here.</p>
            </div>
          ) : (
            <div className="dashboard-table-wrap">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((order) => (
                    <tr key={order.public_order_id}>
                      <td>
                        <Link prefetch={false} href={`/admin/orders/${order.public_order_id}`}>{order.public_order_id}</Link>
                      </td>
                      <td>{(order.profiles as { email?: string } | null)?.email ?? "—"}</td>
                      <td>{order.total} {order.currency}</td>
                      <td>
                        <span className={`admin-status ${order.fulfillment_status.toLowerCase()}`}>
                          {order.fulfillment_status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="admin-provider-panel">
          <div className="admin-panel-heading">
            <div>
              <h2>Provider health</h2>
              <p>ReliableSMM account status.</p>
            </div>
            {providerHealthError ? (
              <AdminQueryError message="Provider health is unavailable." />
            ) : (
              <span className={`provider-health-status ${providerHealth?.balance_status === "SUCCEEDED" ? "is-good" : ""}`}>
                {providerHealth ? (providerHealth.configured ? "Configured" : "Not configured") : "No health record"}
              </span>
            )}
          </div>

          {providerHealthError ? null : (
            <>
              <div className="provider-health-grid">
                <div>
                  <span>Catalog</span>
                  {catalogError ? <AdminQueryError message="Catalog count unavailable." /> : <strong>{catalogCount ?? "Unavailable"}</strong>}
                </div>
                <div>
                  <span>Balance</span>
                  <strong>{formatProviderBalance(providerHealth?.balance, providerHealth?.balance_currency ?? "USD")}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{providerHealth?.balance_status ?? "—"}</strong>
                </div>
                <div>
                  <span>Last check</span>
                  <strong>{providerHealth?.last_balance_check ? new Date(providerHealth.last_balance_check).toLocaleDateString() : "—"}</strong>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                <BalanceRefresh label="Reload balance" />
                <Link prefetch={false} href="/admin/provider-catalog" style={{ color: "#c18aff", fontSize: 13, fontWeight: 700 }}>
                  Catalog ({catalogCount ?? 0}) →
                </Link>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
