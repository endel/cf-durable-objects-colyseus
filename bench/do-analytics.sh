#!/bin/sh
# Per-minute Durable Object CPU, memory and message counts from Cloudflare's
# GraphQL analytics (a few minutes behind real time). Uses wrangler's own login.
#   bench/do-analytics.sh <since ISO time> [namespace id]
# Without a namespace id, every namespace on the account is listed.
TOKEN=$(sed -n 's/^oauth_token = "\(.*\)"/\1/p' "$HOME/Library/Preferences/.wrangler/config/default.toml")
ACCOUNT=$(npx wrangler whoami 2>/dev/null | grep -a -o '[0-9a-f]\{32\}' | head -1)
FILTER='datetime_geq:$t'; [ -n "$2" ] && FILTER="$FILTER, namespaceId:\"$2\""

jq -n --arg a "$ACCOUNT" --arg t "$1" --arg f "$FILTER" '{variables:{a:$a,t:$t}, query:
  "query($a:String!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){
    periodic: durableObjectsPeriodicGroups(limit:1000, filter:{\($f)}, orderBy:[datetimeMinute_ASC]){
      dimensions{datetimeMinute namespaceId}
      sum{cpuTime activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount exceededCpuErrors exceededMemoryErrors}
      max{activeWebsocketConnections memoryUsageBytes}}
    invocations: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{\($f)}, orderBy:[datetimeMinute_ASC]){
      dimensions{datetimeMinute namespaceId status} sum{requests errors}}
  }}}"}' |
  curl -s https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @- |
  jq -c '.errors // empty, (.data.viewer.accounts[0] |
    (.periodic[] | {minute: .dimensions.datetimeMinute[11:16], ns: .dimensions.namespaceId[0:6],
      cpuMs: (.sum.cpuTime / 1000 | floor), cpuPct: (.sum.cpuTime / 600000 | floor),
      msgIn: .sum.inboundWebsocketMsgCount, msgOut: .sum.outboundWebsocketMsgCount,
      sockets: .max.activeWebsocketConnections, memMB: (.max.memoryUsageBytes / 1048576 | floor),
      cpuErr: .sum.exceededCpuErrors, memErr: .sum.exceededMemoryErrors}),
    (.invocations[] | {minute: .dimensions.datetimeMinute[11:16], ns: .dimensions.namespaceId[0:6],
      status: .dimensions.status, requests: .sum.requests, errors: .sum.errors}))'
