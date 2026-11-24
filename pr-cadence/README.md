# PR cadence report

For each developer on the `shrimp-devs` and `otter-devs` teams: PRs opened in any `safeinsights` repo over
the last four weeks, divided by their workdays in that time. ✅ at 1 or more, ⚠️ below 1 with the average.

Workdays are Monday to Friday minus every other Friday (2026-11-06, 2026-11-20, ...) and the holidays and
PTO on the [PR-cadence-days-off](https://github.com/safeinsights/experiments/wiki/PR-cadence-days-off) wiki
page. A deployed copy replaces the [PR-cadence](https://github.com/safeinsights/experiments/wiki/PR-cadence)
wiki page daily at 07:00 Central. The teams, excluded logins, target and Friday cycle are constants in
[pr-cadence.ts](pr-cadence.ts).

## Holidays and PTO

Bullets hold `YYYY-MM-DD` dates or `START..END` ranges; PTO bullets start with the GitHub login; anything
else on a line is a comment. The wiki is public, like this repo.

```markdown
## Holidays

- 2026-11-26..2026-11-27 Thanksgiving

## PTO

- philschatz 2026-12-21..2026-12-24, 2026-12-28
```

## Run it locally

```sh
pnpm pr-cadence             # print the report
pnpm pr-cadence --publish   # also replace the wiki page
pnpm pr-cadence:test
```

It uses `GITHUB_TOKEN`, or `gh auth token` when that is unset. The token needs `repo` and `read:org`.

## Deploy

[stack.ts](stack.ts) deploys a Lambda, a daily schedule and a Secrets Manager secret,
`pr-cadence/github-token`, that holds the only credential.

```sh
AWS_PROFILE=<profile> pnpm pr-cadence:deploy
aws secretsmanager put-secret-value --secret-id pr-cadence/github-token --secret-string file://<token file>
```

A classic token with `repo` and `read:org` works. GitHub does not document whether fine-grained tokens can
push to wikis.
