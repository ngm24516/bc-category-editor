// Everything the editor needs in one resource group:
//   Log Analytics  -> container logs
//   Container Apps environment + two apps (staging, production), both scale to zero when idle
//   PostgreSQL Flexible Server (Burstable B1ms, 32 GB, auto-grow off) with one database per environment
//
// Deploy (see docs/SETUP-AZURE.md):
//   az deployment group create -g rg-bceditor -f infra/main.bicep -p infra/main.bicepparam

@description('Azure region. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Short lowercase prefix for resource names.')
@minLength(3)
@maxLength(12)
param prefix string = 'bceditor'

@description('Container image to start with. The pipeline replaces it on every deploy.')
param image string = 'ghcr.io/ngm24516/bc-category-editor:main'

@description('Postgres administrator login (also used by the app for now).')
param postgresAdminLogin string = 'bcadmin'

@secure()
@description('Postgres administrator password. 12+ characters, mixing upper, lower, digits and symbols.')
param postgresAdminPassword string

@description('Discord application Client ID (not secret).')
param discordClientId string

@secure()
@description('Discord application Client Secret.')
param discordClientSecret string

@description('Comma-separated Discord user IDs that get the admin role.')
param adminDiscordIds string = ''

var tags = { project: 'bc-category-editor' }
var suffix = uniqueString(resourceGroup().id)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32 // the free-account allowance; billed on size provisioned, not used
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

// Only Azure services (our container apps) can connect; TLS is required by default.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

var environments = [
  { name: 'staging', database: 'bceditor_staging', maxReplicas: 1 }
  { name: 'prod', database: 'bceditor_prod', maxReplicas: 2 }
]

resource databases 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for e in environments: {
  parent: pg
  name: e.database
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}]

resource apps 'Microsoft.App/containerApps@2024-03-01' = [for (e, i) in environments: {
  name: '${prefix}-${e.name}'
  location: location
  tags: union(tags, { environment: e.name })
  dependsOn: [databases[i], pgAllowAzure]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'database-url'
          value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${e.database}?sslmode=require'
        }
        {
          name: 'discord-client-secret'
          value: discordClientSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'PUBLIC_URL', value: 'https://${prefix}-${e.name}.${env.properties.defaultDomain}' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DISCORD_CLIENT_ID', value: discordClientId }
            { name: 'DISCORD_CLIENT_SECRET', secretRef: 'discord-client-secret' }
            { name: 'ADMIN_DISCORD_IDS', value: adminDiscordIds }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 3000 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/readyz', port: 3000 }
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0 // scale to zero when idle: free, with a few seconds' start-up on the first visit
        maxReplicas: e.maxReplicas
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}]

output stagingUrl string = 'https://${apps[0].properties.configuration.ingress.fqdn}'
output prodUrl string = 'https://${apps[1].properties.configuration.ingress.fqdn}'
output stagingAppName string = apps[0].name
output prodAppName string = apps[1].name
output postgresServer string = pg.properties.fullyQualifiedDomainName
