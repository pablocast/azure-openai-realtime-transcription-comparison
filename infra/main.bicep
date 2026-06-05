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

@description('Chat (text) model deployment name for the STT->AOAI->TTS pipeline.')
param chatDeploymentName string = 'gpt-5.4'

@description('Underlying chat model name.')
param chatModelName string = 'gpt-5.4'

@description('Underlying chat model version.')
param chatModelVersion string = '2025-11-01'

@description('Mini chat (text) model deployment name for the STT->AOAI->TTS pipeline.')
param miniChatDeploymentName string = 'gpt-5.4-mini'

@description('Underlying mini chat model name.')
param miniChatModelName string = 'gpt-5.4-mini'

@description('Underlying mini chat model version.')
param miniChatModelVersion string = '2025-11-01'

@description('gpt-5-mini chat (text) model deployment name for the STT->AOAI->TTS pipeline.')
param gpt5MiniChatDeploymentName string = 'gpt-5-mini'

@description('Underlying gpt-5-mini chat model name.')
param gpt5MiniChatModelName string = 'gpt-5-mini'

@description('Underlying gpt-5-mini chat model version.')
param gpt5MiniChatModelVersion string = '2025-08-07'

@description('gpt-5.4-nano chat (text) model deployment name for lower-cost pipeline/extraction.')
param gpt54NanoChatDeploymentName string = 'gpt-5.4-nano'

@description('Underlying gpt-5.4-nano chat model name.')
param gpt54NanoChatModelName string = 'gpt-5.4-nano'

@description('Underlying gpt-5.4-nano chat model version.')
param gpt54NanoChatModelVersion string = '2025-11-01'

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
  {
    name: chatDeploymentName
    modelName: chatModelName
    modelVersion: chatModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
  {
    name: miniChatDeploymentName
    modelName: miniChatModelName
    modelVersion: miniChatModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
  {
    name: gpt5MiniChatDeploymentName
    modelName: gpt5MiniChatModelName
    modelVersion: gpt5MiniChatModelVersion
    skuName: modelSkuName
    capacity: modelCapacity
  }
  {
    name: gpt54NanoChatDeploymentName
    modelName: gpt54NanoChatModelName
    modelVersion: gpt54NanoChatModelVersion
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
    azureOpenAiMiniRealtimeDeployment: miniRealtimeDeploymentName
    azureOpenAiTranscriptionModel: transcriptionDeploymentName
    azureOpenAiChatDeployment: chatDeploymentName
    azureOpenAiMiniChatDeployment: miniChatDeploymentName
    azureOpenAiGpt5MiniChatDeployment: gpt5MiniChatDeploymentName
    azureOpenAiGpt54NanoChatDeployment: gpt54NanoChatDeploymentName
    speechEndpoint: foundry.outputs.speechEndpoint
    speechResourceId: foundry.outputs.accountId
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
output AZURE_OPENAI_CHAT_DEPLOYMENT_NAME string = chatDeploymentName
output AZURE_OPENAI_MINI_CHAT_DEPLOYMENT_NAME string = miniChatDeploymentName
output AZURE_OPENAI_GPT5_MINI_CHAT_DEPLOYMENT_NAME string = gpt5MiniChatDeploymentName
output AZURE_OPENAI_GPT5_4_NANO_CHAT_DEPLOYMENT_NAME string = gpt54NanoChatDeploymentName
output AZURE_SPEECH_ENDPOINT string = foundry.outputs.speechEndpoint
output AZURE_SPEECH_RESOURCE_ID string = foundry.outputs.accountId
