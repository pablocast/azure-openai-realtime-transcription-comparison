targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment which is used to generate a short unique hash used in all resources.')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Name of an existing resource group to deploy into.')
param resourceGroupName string

// ---------- Foundry / Azure OpenAI ----------
@description('Name of the AI Foundry / Azure OpenAI account to create. Must be globally unique. Leave empty to auto-name.')
param foundryAccountName string = ''

@description('Name of the Foundry project to create under the account.')
param foundryProjectName string = 'realtime'

@description('Realtime model deployment name to create.')
param realtimeDeploymentName string = 'gpt-realtime-1.5-1'

@description('Underlying realtime model name.')
param realtimeModelName string = 'gpt-realtime'

@description('Underlying realtime model version.')
param realtimeModelVersion string = '2025-08-28'

@description('Mini realtime deployment name to create.')
param miniRealtimeDeploymentName string = 'gpt-realtime-mini-1'

@description('Underlying mini realtime model name.')
param miniRealtimeModelName string = 'gpt-realtime-mini'

@description('Underlying mini realtime model version.')
param miniRealtimeModelVersion string = '2025-10-06'

@description('Transcription model deployment name to create.')
param transcriptionDeploymentName string = 'gpt-4o-transcribe-diarize-1'

@description('Underlying transcription model name.')
param transcriptionModelName string = 'gpt-4o-transcribe-diarize'

@description('Underlying transcription model version.')
param transcriptionModelVersion string = '2025-10-15'

@description('Capacity (TPM in thousands) for each model deployment.')
param modelCapacity int = 50

@description('SKU name for each model deployment.')
param modelSkuName string = 'GlobalStandard'

@description('Voice for the realtime model.')
param realtimeVoice string = 'alloy'

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var effectiveFoundryAccountName = empty(foundryAccountName) ? toLower('foundry-${environmentName}-${resourceToken}') : foundryAccountName

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

var modelDeployments = [
  {
    name: realtimeDeploymentName
    modelName: realtimeModelName
    modelVersion: realtimeModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
  {
    name: miniRealtimeDeploymentName
    modelName: miniRealtimeModelName
    modelVersion: miniRealtimeModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
  {
    name: transcriptionDeploymentName
    modelName: transcriptionModelName
    modelVersion: transcriptionModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
]

module foundry 'foundry.bicep' = {
  name: 'foundry'
  scope: rg
  params: {
    location: location
    tags: tags
    accountName: effectiveFoundryAccountName
    projectName: foundryProjectName
    projectDisplayName: '${environmentName} realtime'
    modelDeployments: modelDeployments
  }
}

module resources 'resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    azureOpenAiEndpoint: foundry.outputs.endpoint
    azureOpenAiRealtimeDeployment: realtimeDeploymentName
    azureOpenAiTranscriptionModel: transcriptionDeploymentName
    realtimeVoice: realtimeVoice
  }
}

module aoaiRoleAssignment 'aoai-role.bicep' = {
  name: 'aoai-role'
  scope: rg
  params: {
    azureOpenAiAccountName: foundry.outputs.accountName
    principalId: resources.outputs.containerAppPrincipalId
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryEndpoint
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.containerRegistryName
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = resources.outputs.containerAppsEnvironmentName
output SERVICE_WEB_NAME string = resources.outputs.containerAppName
output SERVICE_WEB_URI string = resources.outputs.containerAppUri
output AZURE_OPENAI_ENDPOINT string = foundry.outputs.endpoint
output AZURE_OPENAI_ACCOUNT_NAME string = foundry.outputs.accountName
output AZURE_FOUNDRY_PROJECT_NAME string = foundry.outputs.projectName
output AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME string = realtimeDeploymentName
output AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL string = transcriptionDeploymentName
output AZURE_OPENAI_MINI_REALTIME_DEPLOYMENT_NAME string = miniRealtimeDeploymentName
