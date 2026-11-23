# One-time Azure and GitHub setup

Do these once, in order. Everything after this is automatic: merge a pull request → it deploys to
staging → you approve → it deploys to production.

Commands are for PowerShell on Windows, run from the repo folder, after `az login`.

## 1. Discord application

1. <https://discord.com/developers/applications> → **New Application** → name it (e.g. "BC Category Editor").
2. **OAuth2** page: copy the **Client ID**. Click **Reset Secret**, copy the **Client Secret** into your password manager.
   Never commit it or paste it into chat.
3. Under **Redirects**, add `http://localhost:3000/auth/discord/callback` (local testing). You'll add the Azure ones in step 5.
4. Your own Discord user ID, for the admin role: Discord → Settings → Advanced → turn on **Developer Mode**,
   then right-click your name → **Copy User ID**.

## 2. Build the first image

1. Merge the pull request that added this file. The **Deploy** workflow builds the image and pushes it to
   GitHub Container Registry. Its staging/production jobs are skipped until step 6.
2. Make the image public so Azure can pull it without a password: GitHub → your profile → **Packages** →
   `bc-category-editor` → **Package settings** → **Change visibility** → **Public**.

## 3. Fill in the non-secret settings

Edit `infra/main.bicepparam`: set `discordClientId` and `adminDiscordIds` (your Discord user ID).
Commit it through a pull request like any other change.

## 4. Create the Azure resources

```powershell
# New subscriptions must enable these services once
az provider register -n Microsoft.App --wait
az provider register -n Microsoft.OperationalInsights --wait
az provider register -n Microsoft.DBforPostgreSQL --wait

# Secrets come from environment variables, so they never touch a file
$env:PG_ADMIN_PASSWORD = Read-Host "New Postgres admin password (12+ chars, upper/lower/digit/symbol)"
$env:DISCORD_CLIENT_SECRET = Read-Host "Discord Client Secret"

az deployment group create -g rg-bceditor -f infra/main.bicep -p infra/main.bicepparam --query properties.outputs
```

This takes 5–10 minutes (Postgres is the slow part). The output lists `stagingUrl`, `prodUrl`,
`stagingAppName` and `prodAppName`. Keep them.

If it fails with a region or SKU error for Postgres, add `-p location=westus2` (or another nearby region).

Costs: the free account covers Postgres B1ms + 32 GB for 12 months. Container Apps stay within the monthly
free grant at this traffic. Log Analytics charges per GB of logs, which is tiny here. Your $10 budget alert
still applies.

## 5. Tell Discord about the Azure addresses

Discord Developer Portal → your app → **OAuth2** → **Redirects**, add both:

- `<stagingUrl>/auth/discord/callback`
- `<prodUrl>/auth/discord/callback`

## 6. Let GitHub deploy to Azure without a password (OIDC)

This creates an identity in your Azure directory that trusts *only* jobs from this repo running in the
`staging` or `production` GitHub environment.

```powershell
$sub    = az account show --query id -o tsv
$tenant = az account show --query tenantId -o tsv
$appId  = az ad app create --display-name "github-bc-category-editor" --query appId -o tsv
az ad sp create --id $appId | Out-Null
$rg = az group show -n rg-bceditor --query id -o tsv
az role assignment create --assignee $appId --role Contributor --scope $rg | Out-Null

foreach ($envName in "staging", "production") {
  @{ name = "github-$envName"; issuer = "https://token.actions.githubusercontent.com";
     subject = "repo:ngm24516@257171202/bc-category-editor@1468104877:environment:$envName";
     audiences = @("api://AzureADTokenExchange") } | ConvertTo-Json | Out-File -Encoding ascii cred.json
  az ad app federated-credential create --id $appId --parameters cred.json | Out-Null
}
Remove-Item cred.json

"AZURE_CLIENT_ID       = $appId"
"AZURE_TENANT_ID       = $tenant"
"AZURE_SUBSCRIPTION_ID = $sub"
```

The subject includes the account and repository **numbers** (`ngm24516@257171202`, `bc-category-editor@1468104877`):
GitHub now puts those in its OIDC tokens so a renamed or re-created repo can't inherit the trust. If a deploy fails with
`AADSTS700213 No matching federated identity record`, the job log's "subject claim" line shows the exact value to use.

(Contributor on the resource group is broad but simple. Narrowing it to the two container apps is a good
least-privilege exercise later.)

## 7. GitHub repository settings

**Settings → Secrets and variables → Actions → Variables tab → New repository variable**, one each:

| Name | Value |
|---|---|
| `AZURE_CLIENT_ID` | from step 6 |
| `AZURE_TENANT_ID` | from step 6 |
| `AZURE_SUBSCRIPTION_ID` | from step 6 |
| `AZURE_RESOURCE_GROUP` | `rg-bceditor` |
| `STAGING_APP_NAME` | `stagingAppName` from step 4 (`bceditor-staging`) |
| `PROD_APP_NAME` | `prodAppName` from step 4 (`bceditor-prod`) |

None of these are secrets; with OIDC there is no Azure password to store.

**Settings → Environments:**

- **New environment** `staging`: no rules.
- **New environment** `production`: tick **Required reviewers** and add yourself.
  Under **Deployment branches and tags**, choose **Selected branches** and add `main`.

**Settings → Rules → Rulesets → New branch ruleset** (target: default branch):

- Require a pull request before merging.
- Require status checks to pass: `Lint, test, migrations` and `Build and smoke-test the container`.
- Block force pushes.

## 8. First real deploy

**Actions → Deploy → Run workflow**. Staging deploys and is smoke-tested; then the production job waits.
Open the run, click **Review deployments**, approve, and production goes live at `prodUrl`.

## 9. Retire the Static Web App (after production works)

Its workflow was removed from the repo. Delete the leftovers once production is live:

1. Portal → **rg-bceditor** → the Static Web App (`bc-editor`) → **Delete**.
2. GitHub → **Settings** → **Secrets and variables** → **Actions** → delete
   `AZURE_STATIC_WEB_APPS_API_TOKEN_LEMON_MOSS_0954F4110`.

## 10. Turn on mod importing (once, after the importer pull request is merged)

The importer runs as two Azure Container Apps Jobs per environment: `<app>-import` (starts when imports are
queued) and `<app>-updates` (every hour, queues new versions of mods that changed on Steam).

1. After the merge, the **Deploy** workflow also builds `bc-category-editor-importer`. Make that package public
   the same way as step 2: GitHub → your profile → **Packages** → `bc-category-editor-importer` →
   **Package settings** → **Change visibility** → **Public**.
2. Create the jobs by running step 4's deployment again, from an up-to-date `main`, entering each secret
   at its own prompt (paste one line at a time):

   ```powershell
   git checkout main
   git pull
   ```
   ```powershell
   $env:PG_ADMIN_PASSWORD = Read-Host "Postgres admin password (the existing one)"
   ```
   ```powershell
   $env:DISCORD_CLIENT_SECRET = Read-Host "Discord Client Secret"
   ```
   ```powershell
   az deployment group create -g rg-bceditor -f infra/main.bicep -p infra/main.bicepparam --query properties.outputs
   ```

   Use the **existing** Postgres password: entering a new one changes it.
3. Check: portal → **rg-bceditor** shows `bceditor-staging-import`, `bceditor-staging-updates`,
   `bceditor-prod-import` and `bceditor-prod-updates`. Import a mod on staging; the job's **Execution history**
   shows a run start within about a minute, and the mod turns **Ready** in the Mods dialog a few minutes later.

From then on every Deploy updates the jobs' image along with the apps.
