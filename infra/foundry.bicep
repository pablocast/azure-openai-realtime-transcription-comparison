@description('Location for the Foundry/AI Services account.')
param location string

@description('Tags to apply to the Foundry account and project.')
param tags object

@description('Name of the AI Services / Foundry account to create.')
param accountName string

@description('Name of the Foundry project to create under the account.')
param projectName string

@description('Friendly display name for the Foundry project.')
param projectDisplayName string = projectName

@description('Model deployments to create on the Foundry account.')
param modelDeployments array

// AI Foundry / Azure OpenAI account (multi-service AI Services account).
resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    allowProjectManagement: true
  }
}

// Foundry project (child of the AI Services account).
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectDisplayName
    description: 'Foundry project for ${projectDisplayName}'
  }
}

// Model deployments — created sequentially via @batchSize(1) to avoid CogSvc throttling.
@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = [for d in modelDeployments: {
  parent: account
  name: d.name
  sku: {
    name: d.skuName
    capacity: d.capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: d.modelName
      version: d.modelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}]

output accountName string = account.name
output accountId string = account.id
output endpoint string = 'https://${account.name}.openai.azure.com/'
output speechEndpoint string = account.properties.endpoint
output projectName string = project.name
