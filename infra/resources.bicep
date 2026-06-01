param location string
param tags object
param resourceToken string
param azureOpenAiEndpoint string
param azureOpenAiRealtimeDeployment string
param azureOpenAiMiniRealtimeDeployment string = ''
param azureOpenAiTranscriptionModel string
param azureOpenAiChatDeployment string = ''
param azureOpenAiMiniChatDeployment string = ''
param speechEndpoint string = ''
param speechResourceId string = ''
param realtimeVoice string

var abbrs = {
  containerRegistry: 'cr'
  containerAppsEnv: 'cae'
  containerApp: 'ca'
  logAnalytics: 'log'
  managedIdentity: 'id'
}

// ---------- Log Analytics (required by ACA env) ----------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${abbrs.logAnalytics}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------- User-assigned managed identity for the Container App ----------
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${abbrs.managedIdentity}-${resourceToken}'
  location: location
  tags: tags
}

// ---------- Azure Container Registry ----------
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  #disable-next-line BCP334
  name: '${abbrs.containerRegistry}${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

// AcrPull for the UAMI on this ACR
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, uami.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Container Apps Environment ----------
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${abbrs.containerAppsEnv}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------- Container App ----------
// Uses a placeholder image on first deploy; azd will build & push the real image,
// then update the app to point at <acr>/web:<tag>.
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${abbrs.containerApp}-web-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  dependsOn: [ acrPull ]
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: uami.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: 'mcr.microsoft.com/k8se/quickstart:latest'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
            { name: 'AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME', value: azureOpenAiRealtimeDeployment }
            { name: 'AZURE_OPENAI_MINI_REALTIME_DEPLOYMENT_NAME', value: azureOpenAiMiniRealtimeDeployment }
            { name: 'AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL', value: azureOpenAiTranscriptionModel }
            { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT_NAME', value: azureOpenAiChatDeployment }
            { name: 'AZURE_OPENAI_MINI_CHAT_DEPLOYMENT_NAME', value: azureOpenAiMiniChatDeployment }
            { name: 'AZURE_SPEECH_ENDPOINT', value: speechEndpoint }
            { name: 'AZURE_SPEECH_RESOURCE_ID', value: speechResourceId }
            { name: 'REALTIME_VOICE', value: realtimeVoice }
            { name: 'AZURE_CLIENT_ID', value: uami.properties.clientId }
            { name: 'PORT', value: '8080' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output containerRegistryName string = acr.name
output containerRegistryEndpoint string = acr.properties.loginServer
output containerAppsEnvironmentName string = caEnv.name
output containerAppName string = containerApp.name
output containerAppUri string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppPrincipalId string = uami.properties.principalId
