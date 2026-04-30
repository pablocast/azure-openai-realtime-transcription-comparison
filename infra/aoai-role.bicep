@description('Existing Azure OpenAI / Foundry account name to grant access on.')
param azureOpenAiAccountName string

@description('Principal ID of the Container App managed identity.')
param principalId string

resource aoai 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' existing = {
  name: azureOpenAiAccountName
}

// "Cognitive Services OpenAI User"
var aoaiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource aoaiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aoai.id, principalId, aoaiUserRoleId)
  scope: aoai
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aoaiUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
