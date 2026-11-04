// Turn a short-lived Facebook user token (from the Graph API Explorer or the
// Meta app dashboard) into a never-expiring Page access token, and print the
// Page and Instagram account IDs.
//
//   bun run scripts/exchange-token.ts <SHORT_LIVED_USER_TOKEN>
//
// Needs META_APP_ID and META_APP_SECRET in the environment.

const userToken = process.argv[2];
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const version = process.env.META_GRAPH_VERSION ?? "v26.0";
if (!userToken || !appId || !appSecret) {
  console.error("Usage: bun run scripts/exchange-token.ts <USER_TOKEN>  (with META_APP_ID and META_APP_SECRET set)");
  process.exit(1);
}

const graph = async (path: string, params: Record<string, string>) => {
  const res = await fetch(`https://graph.facebook.com/${version}/${path}?${new URLSearchParams(params)}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body;
};

const longLived = await graph("oauth/access_token", {
  grant_type: "fb_exchange_token",
  client_id: appId,
  client_secret: appSecret,
  fb_exchange_token: userToken,
});

const pages = await graph("me/accounts", {
  fields: "id,name,access_token,instagram_business_account{id,username}",
  access_token: longLived.access_token,
});

if (!pages.data?.length) {
  console.error("No Pages found. The token needs pages_show_list and a Page you manage.");
  process.exit(1);
}

for (const page of pages.data) {
  const ig = page.instagram_business_account;
  console.log(`\nPage: ${page.name}`);
  console.log(`  FACEBOOK_PAGE_ID=${page.id}`);
  console.log(`  INSTAGRAM_ACCESS_TOKEN=${page.access_token}`);
  console.log(
    ig
      ? `  INSTAGRAM_ACCOUNT_ID=${ig.id}   (@${ig.username})`
      : "  (no linked Instagram account visible; the token may lack pages_read_engagement)",
  );
}
