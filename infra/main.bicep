// Everything the editor needs in one resource group:
//   Log Analytics  -> container logs
//   Container Apps environment + two apps (staging, production), both scale to zero when idle
//   PostgreSQL Flexible Server (Burstable B1ms, 32 GB, auto-grow off) with one database per environment
//   Per environment, two Container Apps Jobs running the importer image:
//     <app>-import   starts when import_jobs has queued work (KEDA postgresql scaler), drains it, stops
//     <app>-updates  every hour: asks Steam which catalog mods changed and queues their new versions
//     <app>-market   every hour: records every listing of each marketplace an admin added (prices)
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

@description('Importer image (SteamCMD + Python) for the import and update-check jobs. The pipeline replaces it on every deploy.')
param importerImage string = 'ghcr.io/ngm24516/bc-category-editor-importer:main'

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

// The importer: runs only while there is queued work. KEDA polls the queue every 30 s.
resource importJobs 'Microsoft.App/jobs@2024-03-01' = [for (e, i) in environments: {
  name: '${prefix}-${e.name}-import'
  location: location
  tags: union(tags, { environment: e.name })
  dependsOn: [databases[i], pgAllowAzure]
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 3600
      replicaRetryLimit: 0 // the worker records failures on the job row itself
      secrets: [
        {
          name: 'database-url'
          value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${e.database}?sslmode=require'
        }
      ]
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 2
          pollingInterval: 30
          rules: [
            {
              name: 'queued-imports'
              type: 'postgresql'
              metadata: {
                query: 'SELECT count(*) FROM import_jobs WHERE status = \'queued\''
                targetQueryValue: '1'
              }
              auth: [
                { secretRef: 'database-url', triggerParameter: 'connection' }
              ]
            }
          ]
        }
      }
    }
    template: {
      containers: [
        {
          name: 'importer'
          image: importerImage
          args: [ 'run' ]
          env: [ { name: 'DATABASE_URL', secretRef: 'database-url' } ]
          resources: {
            cpu: json('2.0') // more CPU also brings more scratch disk for large downloads
            memory: '4Gi'
          }
        }
      ]
    }
  }
}]

// The hourly update check. Light: one Steam API call per 100 mods, then it queues work for the importer.
resource updateJobs 'Microsoft.App/jobs@2024-03-01' = [for (e, i) in environments: {
  name: '${prefix}-${e.name}-updates'
  location: location
  tags: union(tags, { environment: e.name })
  dependsOn: [databases[i], pgAllowAzure]
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      secrets: [
        {
          name: 'database-url'
          value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${e.database}?sslmode=require'
        }
      ]
      scheduleTriggerConfig: {
        cronExpression: '17 * * * *' // every hour at :17 (UTC), away from the busy top of the hour
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'updates'
          image: importerImage
          args: [ 'check-updates' ]
          env: [ { name: 'DATABASE_URL', secretRef: 'database-url' } ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}]

// Marketplace prices: reads each enabled marketplace's listings API (public https sites only; see
// importer/market.py) and records every listing, so the editor can show average / low / high prices.
resource marketJobs 'Microsoft.App/jobs@2024-03-01' = [for (e, i) in environments: {
  name: '${prefix}-${e.name}-market'
  location: location
  tags: union(tags, { environment: e.name })
  dependsOn: [databases[i], pgAllowAzure]
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 1
      secrets: [
        {
          name: 'database-url'
          value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${e.database}?sslmode=require'
        }
      ]
      scheduleTriggerConfig: {
        cronExpression: '47 * * * *' // every hour at :47 (UTC); the dashboard reads MARKET_CHECK_MINUTE (default 47)
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'market'
          image: importerImage
          args: [ 'market' ]
          env: [ { name: 'DATABASE_URL', secretRef: 'database-url' } ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}]

output stagingUrl string = 'https://${apps[0].properties.configuration.ingress.fqdn}'
output prodUrl string = 'https://${apps[1].properties.configuration.ingress.fqdn}'
output stagingAppName string = apps[0].name
output prodAppName string = apps[1].name
output postgresServer string = pg.properties.fullyQualifiedDomainName
