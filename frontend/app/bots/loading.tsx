import { PageLoading } from "@/components/shell/page-loading";

/**
 * Skeleton for /bots and /bots/[id], rendered inside the persistent bots shell.
 * It is also where a link prefetch stops, so warming a bot link never runs the
 * bot loader on the server.
 */
export default function BotsLoading() {
  return <PageLoading />;
}
