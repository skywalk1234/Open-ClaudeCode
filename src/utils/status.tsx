import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { color, Text } from '../ink.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import { getAccountInformation, isClaudeAISubscriber } from './auth.js';
import { getLargeMemoryFiles, getMemoryFiles, MAX_MEMORY_CHARACTER_COUNT } from './claudemd.js';
import { getDoctorDiagnostic } from './doctorDiagnostic.js';
import { getAWSRegion, getDefaultVertexRegion, isEnvTruthy } from './envUtils.js';
import { getDisplayPath } from './file.js';
import { formatNumber } from './format.js';
import { getIdeClientName, type IDEExtensionInstallationStatus, isJetBrainsIde, toIDEDisplayName } from './ide.js';
import { getClaudeAiUserDefaultModelDescription, modelDisplayString } from './model/model.js';
import { getAPIProvider, getMiniMaxEndpoint } from './model/providers.js';
import { getMTLSConfig } from './mtls.js';
import { checkInstall } from './nativeInstaller/index.js';
import { getProxyUrl } from './proxy.js';
import { SandboxManager } from './sandbox/sandbox-adapter.js';
import { getSettingsWithAllErrors } from './settings/allErrors.js';
import { getEnabledSettingSources, getSettingSourceDisplayNameCapitalized } from './settings/constants.js';
import { getManagedFileSettingsPresence, getPolicySettingsOrigin, getSettingsForSource } from './settings/settings.js';
import type { ThemeName } from './theme.js';
export type Property = {
  label?: string;
  value: React.ReactNode | Array<string>;
};
export type Diagnostic = React.ReactNode;
export function buildSandboxProperties(): Property[] {
  if ("external" !== 'ant') {
    return [];
  }
  const isSandboxed = SandboxManager.isSandboxingEnabled();
  return [{
    label: 'Bash Sandbox',
    value: isSandboxed ? 'Enabled' : 'Disabled'
  }];
}
export function buildIDEProperties(mcpClients: MCPServerConnection[], ideInstallationStatus: IDEExtensionInstallationStatus | null = null, theme: ThemeName): Property[] {
  const ideClient = mcpClients?.find(client => client.name === 'ide');
  if (ideInstallationStatus) {
    const ideName = toIDEDisplayName(ideInstallationStatus.ideType);
    const pluginOrExtension = isJetBrainsIde(ideInstallationStatus.ideType) ? 'plugin' : 'extension';
    if (ideInstallationStatus.error) {
      return [{
        label: 'IDE',
        value: <Text>
              {color('error', theme)(figures.cross)} Error installing {ideName}{' '}
              {pluginOrExtension}: {ideInstallationStatus.error}
              {'\n'}Please restart your IDE and try again.
            </Text>
      }];
    }
    if (ideInstallationStatus.installed) {
      if (ideClient && ideClient.type === 'connected') {
        if (ideInstallationStatus.installedVersion !== ideClient.serverInfo?.version) {
          return [{
            label: 'IDE',
            value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion} (server version: ${ideClient.serverInfo?.version})`
          }];
        } else {
          return [{
            label: 'IDE',
            value: `Connected to ${ideName} ${pluginOrExtension} version ${ideInstallationStatus.installedVersion}`
          }];
        }
      } else {
        return [{
          label: 'IDE',
          value: `Installed ${ideName} ${pluginOrExtension}`
        }];
      }
    }
  } else if (ideClient) {
    const ideName = getIdeClientName(ideClient) ?? 'IDE';
    if (ideClient.type === 'connected') {
      return [{
        label: 'IDE',
        value: `Connected to ${ideName} extension`
      }];
    } else {
      return [{
        label: 'IDE',
        value: `${color('error', theme)(figures.cross)} Not connected to ${ideName}`
      }];
    }
  }
  return [];
}
export function buildMcpProperties(clients: MCPServerConnection[] = [], theme: ThemeName): Property[] {
  const servers = clients.filter(client => client.name !== 'ide');
  if (!servers.length) {
    return [];
  }

  // Summary instead of a full server list — 20+ servers wrapped onto many
  // rows, dominating the Status pane. Show counts by state + /mcp hint.
  const byState = {
    connected: 0,
    pending: 0,
    needsAuth: 0,
    failed: 0
  };
  for (const s of servers) {
    if (s.type === 'connected') byState.connected++;else if (s.type === 'pending') byState.pending++;else if (s.type === 'needs-auth') byState.needsAuth++;else byState.failed++;
  }
  const parts: string[] = [];
  if (byState.connected) parts.push(color('success', theme)(`${byState.connected} connected`));
  if (byState.needsAuth) parts.push(color('warning', theme)(`${byState.needsAuth} need auth`));
  if (byState.pending) parts.push(color('inactive', theme)(`${byState.pending} pending`));
  if (byState.failed) parts.push(color('error', theme)(`${byState.failed} failed`));
  return [{
    label: 'MCP servers',
    value: `${parts.join(', ')} ${color('inactive', theme)('· /mcp')}`
  }];
}
export async function buildMemoryDiagnostics(): Promise<Diagnostic[]> {
  const files = await getMemoryFiles();
  const largeFiles = getLargeMemoryFiles(files);
  const diagnostics: Diagnostic[] = [];
  largeFiles.forEach(file => {
    const displayPath = getDisplayPath(file.path);
    diagnostics.push(`Large ${displayPath} will impact performance (${formatNumber(file.content.length)} chars > ${formatNumber(MAX_MEMORY_CHARACTER_COUNT)})`);
  });
  return diagnostics;
}
export function buildSettingSourcesProperties(): Property[] {
  const enabledSources = getEnabledSettingSources();

  // Filter to only sources that actually have settings loaded
  const sourcesWithSettings = enabledSources.filter(source => {
    const settings = getSettingsForSource(source);
    return settings !== null && Object.keys(settings).length > 0;
  });

  // Map internal names to user-friendly names
  // For policySettings, distinguish between remote and local (or skip if neither exists)
  const sourceNames = sourcesWithSettings.map(source => {
    if (source === 'policySettings') {
      const origin = getPolicySettingsOrigin();
      if (origin === null) {
        return null; // Skip - no policy settings exist
      }
      switch (origin) {
        case 'remote':
          return 'Enterprise managed settings (remote)';
        case 'plist':
          return 'Enterprise managed settings (plist)';
        case 'hklm':
          return 'Enterprise managed settings (HKLM)';
        case 'file':
          {
            const {
              hasBase,
              hasDropIns
            } = getManagedFileSettingsPresence();
            if (hasBase && hasDropIns) {
              return 'Enterprise managed settings (file + drop-ins)';
            }
            if (hasDropIns) {
              return 'Enterprise managed settings (drop-ins)';
            }
            return 'Enterprise managed settings (file)';
          }
        case 'hkcu':
          return 'Enterprise managed settings (HKCU)';
      }
    }
    return getSettingSourceDisplayNameCapitalized(source);
  }).filter((name): name is string => name !== null);
  return [{
    label: 'Setting sources',
    value: sourceNames
  }];
}
export async function buildInstallationDiagnostics(): Promise<Diagnostic[]> {
  const installWarnings = await checkInstall();
  return installWarnings.map(warning => warning.message);
}
export async function buildInstallationHealthDiagnostics(): Promise<Diagnostic[]> {
  const diagnostic = await getDoctorDiagnostic();
  const items: Diagnostic[] = [];
  const {
    errors: validationErrors
  } = getSettingsWithAllErrors();
  if (validationErrors.length > 0) {
    const invalidFiles = Array.from(new Set(validationErrors.map(error => error.file)));
    const fileList = invalidFiles.join(', ');
    items.push(`Found invalid settings files: ${fileList}. They will be ignored.`);
  }

  // Add warnings from doctor diagnostic (includes leftover installations, config mismatches, etc.)
  diagnostic.warnings.forEach(warning => {
    items.push(warning.issue);
  });
  if (diagnostic.hasUpdatePermissions === false) {
    items.push('No write permissions for auto-updates (requires sudo)');
  }
  return items;
}
export function buildAccountProperties(): Property[] {
  const accountInfo = getAccountInformation();
  if (!accountInfo) {
    return [];
  }
  const properties: Property[] = [];
  if (accountInfo.subscription) {
    properties.push({
      label: 'Login method',
      value: `${accountInfo.subscription} Account`
    });
  }
  if (accountInfo.tokenSource) {
    properties.push({
      label: 'Auth token',
      value: accountInfo.tokenSource
    });
  }
  if (accountInfo.apiKeySource) {
    properties.push({
      label: 'API key',
      value: accountInfo.apiKeySource
    });
  }

  // Hide sensitive account info in demo mode
  if (accountInfo.organization && !process.env.IS_DEMO) {
    properties.push({
      label: 'Organization',
      value: accountInfo.organization
    });
  }
  if (accountInfo.email && !process.env.IS_DEMO) {
    properties.push({
      label: 'Email',
      value: accountInfo.email
    });
  }
  return properties;
}
export function buildAPIProviderProperties(): Property[] {
  const apiProvider = getAPIProvider();
  const properties: Property[] = [];
  if (apiProvider !== 'firstParty') {
    const providerLabel = {
      bedrock: 'AWS Bedrock',
      vertex: 'Google Vertex AI',
      foundry: 'Microsoft Foundry',
      minimax: 'MiniMax'
    }[apiProvider];
    properties.push({
      label: 'API provider',
      value: providerLabel
    });
  }
  if (apiProvider === 'firstParty') {
    const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    if (anthropicBaseUrl) {
      properties.push({
        label: 'Anthropic base URL',
        value: anthropicBaseUrl
      });
    }
  } else if (apiProvider === 'bedrock') {
    const bedrockBaseUrl = process.env.BEDROCK_BASE_URL;
    if (bedrockBaseUrl) {
      properties.push({
        label: 'Bedrock base URL',
        value: bedrockBaseUrl
      });
    }
    properties.push({
      label: 'AWS region',
      value: getAWSRegion()
    });
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      properties.push({
        value: 'AWS auth skipped'
      });
    }
  } else if (apiProvider === 'vertex') {
    const vertexBaseUrl = process.env.VERTEX_BASE_URL;
    if (vertexBaseUrl) {
      properties.push({
        label: 'Vertex base URL',
        value: vertexBaseUrl
      });
    }
    const gcpProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    if (gcpProject) {
      properties.push({
        label: 'GCP project',
        value: gcpProject
      });
    }
    properties.push({
      label: 'Default region',
      value: getDefaultVertexRegion()
    });
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      properties.push({
        value: 'GCP auth skipped'
      });
    }
  } else if (apiProvider === 'foundry') {
    const foundryBaseUrl = process.env.ANTHROPIC_FOUNDRY_BASE_URL;
    if (foundryBaseUrl) {
      properties.push({
        label: 'Microsoft Foundry base URL',
        value: foundryBaseUrl
      });
    }
    const foundryResource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    if (foundryResource) {
      properties.push({
        label: 'Microsoft Foundry resource',
        value: foundryResource
      });
    }
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
      properties.push({
        value: 'Microsoft Foundry auth skipped'
      });
    }
  } else if (apiProvider === 'minimax') {
    const endpoint = getMiniMaxEndpoint();
    properties.push({
      label: 'MiniMax region',
      value: endpoint.region
    });
    properties.push({
      label: 'MiniMax Anthropic base URL',
      value: process.env.ANTHROPIC_BASE_URL || endpoint.anthropicBaseUrl
    });
  }
  const proxyUrl = getProxyUrl();
  if (proxyUrl) {
    properties.push({
      label: 'Proxy',
      value: proxyUrl
    });
  }
  const mtlsConfig = getMTLSConfig();
  if (process.env.NODE_EXTRA_CA_CERTS) {
    properties.push({
      label: 'Additional CA cert(s)',
      value: process.env.NODE_EXTRA_CA_CERTS
    });
  }
  if (mtlsConfig) {
    if (mtlsConfig.cert && process.env.CLAUDE_CODE_CLIENT_CERT) {
      properties.push({
        label: 'mTLS client cert',
        value: process.env.CLAUDE_CODE_CLIENT_CERT
      });
    }
    if (mtlsConfig.key && process.env.CLAUDE_CODE_CLIENT_KEY) {
      properties.push({
        label: 'mTLS client key',
        value: process.env.CLAUDE_CODE_CLIENT_KEY
      });
    }
  }
  return properties;
}
export function getModelDisplayLabel(mainLoopModel: string | null): string {
  let modelLabel = modelDisplayString(mainLoopModel);
  if (mainLoopModel === null && isClaudeAISubscriber()) {
    const description = getClaudeAiUserDefaultModelDescription();
    modelLabel = `${chalk.bold('Default')} ${description}`;
  }
  return modelLabel;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLnRzeCIsIm5hbWVzIjpbXSwic291cmNlcyI6WyJzdGF0dXMudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjaGFsayBmcm9tICdjaGFsayc7XG5pbXBvcnQgZmlndXJlcyBmcm9tICdmaWd1cmVzJztcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCB7IGNvbG9yLCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJztcbmltcG9ydCB0eXBlIHsgTUNQU2VydmVyQ29ubmVjdGlvbiB9IGZyb20gJy4uL3NlcnZpY2VzL21jcC90eXBlcy5qcyc7XG5pbXBvcnQgeyBnZXRBY2NvdW50SW5mb3JtYXRpb24sIGlzQ2xhdWRlQUlTdWJzY3JpYmVyIH0gZnJvbSAnLi9hdXRoLmpzJztcbmltcG9ydCB7IGdldExhcmdlTWVtb3J5RmlsZXMsIGdldE1lbW9yeUZpbGVzLCBNQVhfTUVNT1JZX0NIQVJBQ1RFUl9DT1VOVCB9IGZyb20gJy4vY2xhdWRlbWQuanMnO1xuaW1wb3J0IHsgZ2V0RG9jdG9yRGlhZ25vc3RpYyB9IGZyb20gJy4vZG9jdG9yRGlhZ25vc3RpYy5qcyc7XG5pbXBvcnQgeyBnZXRBV1NSZWdpb24sIGdldERlZmF1bHRWZXJ0ZXhSZWdpb24sIGlzRW52VHJ1dGh5IH0gZnJvbSAnLi9lbnZVdGlscy5qcyc7XG5pbXBvcnQgeyBnZXREaXNwbGF5UGF0aCB9IGZyb20gJy4vZmlsZS5qcyc7XG5pbXBvcnQgeyBmb3JtYXROdW1iZXIgfSBmcm9tICcuL2Zvcm1hdC5qcyc7XG5pbXBvcnQgeyBnZXRJZGVDbGllbnROYW1lLCB0eXBlIElERUV4dGVuc2lvbkluc3RhbGxhdGlvblN0YXR1cywgaXNKZXRCcmFpbnNJZGUsIHRvSURFRGlzcGxheU5hbWUgfSBmcm9tICcuL2lkZS5qcyc7XG5pbXBvcnQgeyBnZXRDbGF1ZGVBaVVzZXJEZWZhdWx0TW9kZWxEZXNjcmlwdGlvbiwgbW9kZWxEaXNwbGF5U3RyaW5nIH0gZnJvbSAnLi9tb2RlbC9tb2RlbC5qcyc7XG5pbXBvcnQgeyBnZXRBUElQcm92aWRlciwgZ2V0TWluaU1heEVuZHBvaW50IH0gZnJvbSAnLi9tb2RlbC9wcm92aWRlcnMuanMnO1xuaW1wb3J0IHsgZ2V0TVRMU0NvbmZpZyB9IGZyb20gJy4vbXRscy5qcyc7XG5pbXBvcnQgeyBjaGVja0luc3RhbGwgfSBmcm9tICcuL25hdGl2ZUluc3RhbGxlci9pbmRleC5qcyc7XG5pbXBvcnQgeyBnZXRQcm94eVVybCB9IGZyb20gJy4vcHJveHkuanMnO1xuaW1wb3J0IHsgU2FuZGJveE1hbmFnZXIgfSBmcm9tICcuL3NhbmRib3gvc2FuZGJveC1hZGFwdGVyLmpzJztcbmltcG9ydCB7IGdldFNldHRpbmdzV2l0aEFsbEVycm9ycyB9IGZyb20gJy4vc2V0dGluZ3MvYWxsRXJyb3JzLmpzJztcbmltcG9ydCB7IGdldEVuYWJsZWRTZXR0aW5nU291cmNlcywgZ2V0U2V0dGluZ1NvdXJjZURpc3BsYXlOYW1lQ2FwaXRhbGl6ZWQgfSBmcm9tICcuL3NldHRpbmdzL2NvbnN0YW50cy5qcyc7XG5pbXBvcnQgeyBnZXRNYW5hZ2VkRmlsZVNldHRpbmdzUHJlc2VuY2UsIGdldFBvbGljeVNldHRpbmdzT3JpZ2luLCBnZXRTZXR0aW5nc0ZvclNvdXJjZSB9IGZyb20gJy4vc2V0dGluZ3Mvc2V0dGluZ3MuanMnO1xuaW1wb3J0IHR5cGUgeyBUaGVtZU5hbWUgfSBmcm9tICcuL3RoZW1lLmpzJztcbmV4cG9ydCB0eXBlIFByb3BlcnR5ID0ge1xuICBsYWJlbD86IHN0cmluZztcbiAgdmFsdWU6IFJlYWN0LlJlYWN0Tm9kZSB8IEFycmF5PHN0cmluZz47XG59O1xuZXhwb3J0IHR5cGUgRGlhZ25vc3RpYyA9IFJlYWN0LlJlYWN0Tm9kZTtcbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNhbmRib3hQcm9wZXJ0aWVzKCk6IFByb3BlcnR5W10ge1xuICBpZiAoXCJleHRlcm5hbFwiICE9PSAnYW50Jykge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBpc1NhbmRib3hlZCA9IFNhbmRib3hNYW5hZ2VyLmlzU2FuZGJveGluZ0VuYWJsZWQoKTtcbiAgcmV0dXJuIFt7XG4gICAgbGFiZWw6ICdCYXNoIFNhbmRib3gnLFxuICAgIHZhbHVlOiBpc1NhbmRib3hlZCA/ICdFbmFibGVkJyA6ICdEaXNhYmxlZCdcbiAgfV07XG59XG5leHBvcnQgZnVuY3Rpb24gYnVpbGRJREVQcm9wZXJ0aWVzKG1jcENsaWVudHM6IE1DUFNlcnZlckNvbm5lY3Rpb25bXSwgaWRlSW5zdGFsbGF0aW9uU3RhdHVzOiBJREVFeHRlbnNpb25JbnN0YWxsYXRpb25TdGF0dXMgfCBudWxsID0gbnVsbCwgdGhlbWU6IFRoZW1lTmFtZSk6IFByb3BlcnR5W10ge1xuICBjb25zdCBpZGVDbGllbnQgPSBtY3BDbGllbnRzPy5maW5kKGNsaWVudCA9PiBjbGllbnQubmFtZSA9PT0gJ2lkZScpO1xuICBpZiAoaWRlSW5zdGFsbGF0aW9uU3RhdHVzKSB7XG4gICAgY29uc3QgaWRlTmFtZSA9IHRvSURFRGlzcGxheU5hbWUoaWRlSW5zdGFsbGF0aW9uU3RhdHVzLmlkZVR5cGUpO1xuICAgIGNvbnN0IHBsdWdpbk9yRXh0ZW5zaW9uID0gaXNKZXRCcmFpbnNJZGUoaWRlSW5zdGFsbGF0aW9uU3RhdHVzLmlkZVR5cGUpID8gJ3BsdWdpbicgOiAnZXh0ZW5zaW9uJztcbiAgICBpZiAoaWRlSW5zdGFsbGF0aW9uU3RhdHVzLmVycm9yKSB7XG4gICAgICByZXR1cm4gW3tcbiAgICAgICAgbGFiZWw6ICdJREUnLFxuICAgICAgICB2YWx1ZTogPFRleHQ+XG4gICAgICAgICAgICAgIHtjb2xvcignZXJyb3InLCB0aGVtZSkoZmlndXJlcy5jcm9zcyl9IEVycm9yIGluc3RhbGxpbmcge2lkZU5hbWV9eycgJ31cbiAgICAgICAgICAgICAge3BsdWdpbk9yRXh0ZW5zaW9ufToge2lkZUluc3RhbGxhdGlvblN0YXR1cy5lcnJvcn1cbiAgICAgICAgICAgICAgeydcXG4nfVBsZWFzZSByZXN0YXJ0IHlvdXIgSURFIGFuZCB0cnkgYWdhaW4uXG4gICAgICAgICAgICA8L1RleHQ+XG4gICAgICB9XTtcbiAgICB9XG4gICAgaWYgKGlkZUluc3RhbGxhdGlvblN0YXR1cy5pbnN0YWxsZWQpIHtcbiAgICAgIGlmIChpZGVDbGllbnQgJiYgaWRlQ2xpZW50LnR5cGUgPT09ICdjb25uZWN0ZWQnKSB7XG4gICAgICAgIGlmIChpZGVJbnN0YWxsYXRpb25TdGF0dXMuaW5zdGFsbGVkVmVyc2lvbiAhPT0gaWRlQ2xpZW50LnNlcnZlckluZm8/LnZlcnNpb24pIHtcbiAgICAgICAgICByZXR1cm4gW3tcbiAgICAgICAgICAgIGxhYmVsOiAnSURFJyxcbiAgICAgICAgICAgIHZhbHVlOiBgQ29ubmVjdGVkIHRvICR7aWRlTmFtZX0gJHtwbHVnaW5PckV4dGVuc2lvbn0gdmVyc2lvbiAke2lkZUluc3RhbGxhdGlvblN0YXR1cy5pbnN0YWxsZWRWZXJzaW9ufSAoc2VydmVyIHZlcnNpb246ICR7aWRlQ2xpZW50LnNlcnZlckluZm8/LnZlcnNpb259KWBcbiAgICAgICAgICB9XTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gW3tcbiAgICAgICAgICAgIGxhYmVsOiAnSURFJyxcbiAgICAgICAgICAgIHZhbHVlOiBgQ29ubmVjdGVkIHRvICR7aWRlTmFtZX0gJHtwbHVnaW5PckV4dGVuc2lvbn0gdmVyc2lvbiAke2lkZUluc3RhbGxhdGlvblN0YXR1cy5pbnN0YWxsZWRWZXJzaW9ufWBcbiAgICAgICAgICB9XTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIFt7XG4gICAgICAgICAgbGFiZWw6ICdJREUnLFxuICAgICAgICAgIHZhbHVlOiBgSW5zdGFsbGVkICR7aWRlTmFtZX0gJHtwbHVnaW5PckV4dGVuc2lvbn1gXG4gICAgICAgIH1dO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIGlmIChpZGVDbGllbnQpIHtcbiAgICBjb25zdCBpZGVOYW1lID0gZ2V0SWRlQ2xpZW50TmFtZShpZGVDbGllbnQpID8/ICdJREUnO1xuICAgIGlmIChpZGVDbGllbnQudHlwZSA9PT0gJ2Nvbm5lY3RlZCcpIHtcbiAgICAgIHJldHVybiBbe1xuICAgICAgICBsYWJlbDogJ0lERScsXG4gICAgICAgIHZhbHVlOiBgQ29ubmVjdGVkIHRvICR7aWRlTmFtZX0gZXh0ZW5zaW9uYFxuICAgICAgfV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBbe1xuICAgICAgICBsYWJlbDogJ0lERScsXG4gICAgICAgIHZhbHVlOiBgJHtjb2xvcignZXJyb3InLCB0aGVtZSkoZmlndXJlcy5jcm9zcyl9IE5vdCBjb25uZWN0ZWQgdG8gJHtpZGVOYW1lfWBcbiAgICAgIH1dO1xuICAgIH1cbiAgfVxuICByZXR1cm4gW107XG59XG5leHBvcnQgZnVuY3Rpb24gYnVpbGRNY3BQcm9wZXJ0aWVzKGNsaWVudHM6IE1DUFNlcnZlckNvbm5lY3Rpb25bXSA9IFtdLCB0aGVtZTogVGhlbWVOYW1lKTogUHJvcGVydHlbXSB7XG4gIGNvbnN0IHNlcnZlcnMgPSBjbGllbnRzLmZpbHRlcihjbGllbnQgPT4gY2xpZW50Lm5hbWUgIT09ICdpZGUnKTtcbiAgaWYgKCFzZXJ2ZXJzLmxlbmd0aCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIC8vIFN1bW1hcnkgaW5zdGVhZCBvZiBhIGZ1bGwgc2VydmVyIGxpc3Qg4oCUIDIwKyBzZXJ2ZXJzIHdyYXBwZWQgb250byBtYW55XG4gIC8vIHJvd3MsIGRvbWluYXRpbmcgdGhlIFN0YXR1cyBwYW5lLiBTaG93IGNvdW50cyBieSBzdGF0ZSArIC9tY3AgaGludC5cbiAgY29uc3QgYnlTdGF0ZSA9IHtcbiAgICBjb25uZWN0ZWQ6IDAsXG4gICAgcGVuZGluZzogMCxcbiAgICBuZWVkc0F1dGg6IDAsXG4gICAgZmFpbGVkOiAwXG4gIH07XG4gIGZvciAoY29uc3QgcyBvZiBzZXJ2ZXJzKSB7XG4gICAgaWYgKHMudHlwZSA9PT0gJ2Nvbm5lY3RlZCcpIGJ5U3RhdGUuY29ubmVjdGVkKys7ZWxzZSBpZiAocy50eXBlID09PSAncGVuZGluZycpIGJ5U3RhdGUucGVuZGluZysrO2Vsc2UgaWYgKHMudHlwZSA9PT0gJ25lZWRzLWF1dGgnKSBieVN0YXRlLm5lZWRzQXV0aCsrO2Vsc2UgYnlTdGF0ZS5mYWlsZWQrKztcbiAgfVxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKGJ5U3RhdGUuY29ubmVjdGVkKSBwYXJ0cy5wdXNoKGNvbG9yKCdzdWNjZXNzJywgdGhlbWUpKGAke2J5U3RhdGUuY29ubmVjdGVkfSBjb25uZWN0ZWRgKSk7XG4gIGlmIChieVN0YXRlLm5lZWRzQXV0aCkgcGFydHMucHVzaChjb2xvcignd2FybmluZycsIHRoZW1lKShgJHtieVN0YXRlLm5lZWRzQXV0aH0gbmVlZCBhdXRoYCkpO1xuICBpZiAoYnlTdGF0ZS5wZW5kaW5nKSBwYXJ0cy5wdXNoKGNvbG9yKCdpbmFjdGl2ZScsIHRoZW1lKShgJHtieVN0YXRlLnBlbmRpbmd9IHBlbmRpbmdgKSk7XG4gIGlmIChieVN0YXRlLmZhaWxlZCkgcGFydHMucHVzaChjb2xvcignZXJyb3InLCB0aGVtZSkoYCR7YnlTdGF0ZS5mYWlsZWR9IGZhaWxlZGApKTtcbiAgcmV0dXJuIFt7XG4gICAgbGFiZWw6ICdNQ1Agc2VydmVycycsXG4gICAgdmFsdWU6IGAke3BhcnRzLmpvaW4oJywgJyl9ICR7Y29sb3IoJ2luYWN0aXZlJywgdGhlbWUpKCfCtyAvbWNwJyl9YFxuICB9XTtcbn1cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZE1lbW9yeURpYWdub3N0aWNzKCk6IFByb21pc2U8RGlhZ25vc3RpY1tdPiB7XG4gIGNvbnN0IGZpbGVzID0gYXdhaXQgZ2V0TWVtb3J5RmlsZXMoKTtcbiAgY29uc3QgbGFyZ2VGaWxlcyA9IGdldExhcmdlTWVtb3J5RmlsZXMoZmlsZXMpO1xuICBjb25zdCBkaWFnbm9zdGljczogRGlhZ25vc3RpY1tdID0gW107XG4gIGxhcmdlRmlsZXMuZm9yRWFjaChmaWxlID0+IHtcbiAgICBjb25zdCBkaXNwbGF5UGF0aCA9IGdldERpc3BsYXlQYXRoKGZpbGUucGF0aCk7XG4gICAgZGlhZ25vc3RpY3MucHVzaChgTGFyZ2UgJHtkaXNwbGF5UGF0aH0gd2lsbCBpbXBhY3QgcGVyZm9ybWFuY2UgKCR7Zm9ybWF0TnVtYmVyKGZpbGUuY29udGVudC5sZW5ndGgpfSBjaGFycyA+ICR7Zm9ybWF0TnVtYmVyKE1BWF9NRU1PUllfQ0hBUkFDVEVSX0NPVU5UKX0pYCk7XG4gIH0pO1xuICByZXR1cm4gZGlhZ25vc3RpY3M7XG59XG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZXR0aW5nU291cmNlc1Byb3BlcnRpZXMoKTogUHJvcGVydHlbXSB7XG4gIGNvbnN0IGVuYWJsZWRTb3VyY2VzID0gZ2V0RW5hYmxlZFNldHRpbmdTb3VyY2VzKCk7XG5cbiAgLy8gRmlsdGVyIHRvIG9ubHkgc291cmNlcyB0aGF0IGFjdHVhbGx5IGhhdmUgc2V0dGluZ3MgbG9hZGVkXG4gIGNvbnN0IHNvdXJjZXNXaXRoU2V0dGluZ3MgPSBlbmFibGVkU291cmNlcy5maWx0ZXIoc291cmNlID0+IHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IGdldFNldHRpbmdzRm9yU291cmNlKHNvdXJjZSk7XG4gICAgcmV0dXJuIHNldHRpbmdzICE9PSBudWxsICYmIE9iamVjdC5rZXlzKHNldHRpbmdzKS5sZW5ndGggPiAwO1xuICB9KTtcblxuICAvLyBNYXAgaW50ZXJuYWwgbmFtZXMgdG8gdXNlci1mcmllbmRseSBuYW1lc1xuICAvLyBGb3IgcG9saWN5U2V0dGluZ3MsIGRpc3Rpbmd1aXNoIGJldHdlZW4gcmVtb3RlIGFuZCBsb2NhbCAob3Igc2tpcCBpZiBuZWl0aGVyIGV4aXN0cylcbiAgY29uc3Qgc291cmNlTmFtZXMgPSBzb3VyY2VzV2l0aFNldHRpbmdzLm1hcChzb3VyY2UgPT4ge1xuICAgIGlmIChzb3VyY2UgPT09ICdwb2xpY3lTZXR0aW5ncycpIHtcbiAgICAgIGNvbnN0IG9yaWdpbiA9IGdldFBvbGljeVNldHRpbmdzT3JpZ2luKCk7XG4gICAgICBpZiAob3JpZ2luID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBudWxsOyAvLyBTa2lwIC0gbm8gcG9saWN5IHNldHRpbmdzIGV4aXN0XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKG9yaWdpbikge1xuICAgICAgICBjYXNlICdyZW1vdGUnOlxuICAgICAgICAgIHJldHVybiAnRW50ZXJwcmlzZSBtYW5hZ2VkIHNldHRpbmdzIChyZW1vdGUpJztcbiAgICAgICAgY2FzZSAncGxpc3QnOlxuICAgICAgICAgIHJldHVybiAnRW50ZXJwcmlzZSBtYW5hZ2VkIHNldHRpbmdzIChwbGlzdCknO1xuICAgICAgICBjYXNlICdoa2xtJzpcbiAgICAgICAgICByZXR1cm4gJ0VudGVycHJpc2UgbWFuYWdlZCBzZXR0aW5ncyAoSEtMTSknO1xuICAgICAgICBjYXNlICdmaWxlJzpcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICAgIGhhc0Jhc2UsXG4gICAgICAgICAgICAgIGhhc0Ryb3BJbnNcbiAgICAgICAgICAgIH0gPSBnZXRNYW5hZ2VkRmlsZVNldHRpbmdzUHJlc2VuY2UoKTtcbiAgICAgICAgICAgIGlmIChoYXNCYXNlICYmIGhhc0Ryb3BJbnMpIHtcbiAgICAgICAgICAgICAgcmV0dXJuICdFbnRlcnByaXNlIG1hbmFnZWQgc2V0dGluZ3MgKGZpbGUgKyBkcm9wLWlucyknO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGhhc0Ryb3BJbnMpIHtcbiAgICAgICAgICAgICAgcmV0dXJuICdFbnRlcnByaXNlIG1hbmFnZWQgc2V0dGluZ3MgKGRyb3AtaW5zKSc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gJ0VudGVycHJpc2UgbWFuYWdlZCBzZXR0aW5ncyAoZmlsZSknO1xuICAgICAgICAgIH1cbiAgICAgICAgY2FzZSAnaGtjdSc6XG4gICAgICAgICAgcmV0dXJuICdFbnRlcnByaXNlIG1hbmFnZWQgc2V0dGluZ3MgKEhLQ1UpJztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGdldFNldHRpbmdTb3VyY2VEaXNwbGF5TmFtZUNhcGl0YWxpemVkKHNvdXJjZSk7XG4gIH0pLmZpbHRlcigobmFtZSk6IG5hbWUgaXMgc3RyaW5nID0+IG5hbWUgIT09IG51bGwpO1xuICByZXR1cm4gW3tcbiAgICBsYWJlbDogJ1NldHRpbmcgc291cmNlcycsXG4gICAgdmFsdWU6IHNvdXJjZU5hbWVzXG4gIH1dO1xufVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkSW5zdGFsbGF0aW9uRGlhZ25vc3RpY3MoKTogUHJvbWlzZTxEaWFnbm9zdGljW10+IHtcbiAgY29uc3QgaW5zdGFsbFdhcm5pbmdzID0gYXdhaXQgY2hlY2tJbnN0YWxsKCk7XG4gIHJldHVybiBpbnN0YWxsV2FybmluZ3MubWFwKHdhcm5pbmcgPT4gd2FybmluZy5tZXNzYWdlKTtcbn1cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEluc3RhbGxhdGlvbkhlYWx0aERpYWdub3N0aWNzKCk6IFByb21pc2U8RGlhZ25vc3RpY1tdPiB7XG4gIGNvbnN0IGRpYWdub3N0aWMgPSBhd2FpdCBnZXREb2N0b3JEaWFnbm9zdGljKCk7XG4gIGNvbnN0IGl0ZW1zOiBEaWFnbm9zdGljW10gPSBbXTtcbiAgY29uc3Qge1xuICAgIGVycm9yczogdmFsaWRhdGlvbkVycm9yc1xuICB9ID0gZ2V0U2V0dGluZ3NXaXRoQWxsRXJyb3JzKCk7XG4gIGlmICh2YWxpZGF0aW9uRXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBpbnZhbGlkRmlsZXMgPSBBcnJheS5mcm9tKG5ldyBTZXQodmFsaWRhdGlvbkVycm9ycy5tYXAoZXJyb3IgPT4gZXJyb3IuZmlsZSkpKTtcbiAgICBjb25zdCBmaWxlTGlzdCA9IGludmFsaWRGaWxlcy5qb2luKCcsICcpO1xuICAgIGl0ZW1zLnB1c2goYEZvdW5kIGludmFsaWQgc2V0dGluZ3MgZmlsZXM6ICR7ZmlsZUxpc3R9LiBUaGV5IHdpbGwgYmUgaWdub3JlZC5gKTtcbiAgfVxuXG4gIC8vIEFkZCB3YXJuaW5ncyBmcm9tIGRvY3RvciBkaWFnbm9zdGljIChpbmNsdWRlcyBsZWZ0b3ZlciBpbnN0YWxsYXRpb25zLCBjb25maWcgbWlzbWF0Y2hlcywgZXRjLilcbiAgZGlhZ25vc3RpYy53YXJuaW5ncy5mb3JFYWNoKHdhcm5pbmcgPT4ge1xuICAgIGl0ZW1zLnB1c2god2FybmluZy5pc3N1ZSk7XG4gIH0pO1xuICBpZiAoZGlhZ25vc3RpYy5oYXNVcGRhdGVQZXJtaXNzaW9ucyA9PT0gZmFsc2UpIHtcbiAgICBpdGVtcy5wdXNoKCdObyB3cml0ZSBwZXJtaXNzaW9ucyBmb3IgYXV0by11cGRhdGVzIChyZXF1aXJlcyBzdWRvKScpO1xuICB9XG4gIHJldHVybiBpdGVtcztcbn1cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEFjY291bnRQcm9wZXJ0aWVzKCk6IFByb3BlcnR5W10ge1xuICBjb25zdCBhY2NvdW50SW5mbyA9IGdldEFjY291bnRJbmZvcm1hdGlvbigpO1xuICBpZiAoIWFjY291bnRJbmZvKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGNvbnN0IHByb3BlcnRpZXM6IFByb3BlcnR5W10gPSBbXTtcbiAgaWYgKGFjY291bnRJbmZvLnN1YnNjcmlwdGlvbikge1xuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ0xvZ2luIG1ldGhvZCcsXG4gICAgICB2YWx1ZTogYCR7YWNjb3VudEluZm8uc3Vic2NyaXB0aW9ufSBBY2NvdW50YFxuICAgIH0pO1xuICB9XG4gIGlmIChhY2NvdW50SW5mby50b2tlblNvdXJjZSkge1xuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ0F1dGggdG9rZW4nLFxuICAgICAgdmFsdWU6IGFjY291bnRJbmZvLnRva2VuU291cmNlXG4gICAgfSk7XG4gIH1cbiAgaWYgKGFjY291bnRJbmZvLmFwaUtleVNvdXJjZSkge1xuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ0FQSSBrZXknLFxuICAgICAgdmFsdWU6IGFjY291bnRJbmZvLmFwaUtleVNvdXJjZVxuICAgIH0pO1xuICB9XG5cbiAgLy8gSGlkZSBzZW5zaXRpdmUgYWNjb3VudCBpbmZvIGluIGRlbW8gbW9kZVxuICBpZiAoYWNjb3VudEluZm8ub3JnYW5pemF0aW9uICYmICFwcm9jZXNzLmVudi5JU19ERU1PKSB7XG4gICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgIGxhYmVsOiAnT3JnYW5pemF0aW9uJyxcbiAgICAgIHZhbHVlOiBhY2NvdW50SW5mby5vcmdhbml6YXRpb25cbiAgICB9KTtcbiAgfVxuICBpZiAoYWNjb3VudEluZm8uZW1haWwgJiYgIXByb2Nlc3MuZW52LklTX0RFTU8pIHtcbiAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgbGFiZWw6ICdFbWFpbCcsXG4gICAgICB2YWx1ZTogYWNjb3VudEluZm8uZW1haWxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcHJvcGVydGllcztcbn1cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEFQSVByb3ZpZGVyUHJvcGVydGllcygpOiBQcm9wZXJ0eVtdIHtcbiAgY29uc3QgYXBpUHJvdmlkZXIgPSBnZXRBUElQcm92aWRlcigpO1xuICBjb25zdCBwcm9wZXJ0aWVzOiBQcm9wZXJ0eVtdID0gW107XG4gIGlmIChhcGlQcm92aWRlciAhPT0gJ2ZpcnN0UGFydHknKSB7XG4gICAgY29uc3QgcHJvdmlkZXJMYWJlbCA9IHtcbiAgICAgIGJlZHJvY2s6ICdBV1MgQmVkcm9jaycsXG4gICAgICB2ZXJ0ZXg6ICdHb29nbGUgVmVydGV4IEFJJyxcbiAgICAgIGZvdW5kcnk6ICdNaWNyb3NvZnQgRm91bmRyeScsXG4gICAgICBtaW5pbWF4OiAnTWluaU1heCdcbiAgICB9W2FwaVByb3ZpZGVyXTtcbiAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgbGFiZWw6ICdBUEkgcHJvdmlkZXInLFxuICAgICAgdmFsdWU6IHByb3ZpZGVyTGFiZWxcbiAgICB9KTtcbiAgfVxuICBpZiAoYXBpUHJvdmlkZXIgPT09ICdmaXJzdFBhcnR5Jykge1xuICAgIGNvbnN0IGFudGhyb3BpY0Jhc2VVcmwgPSBwcm9jZXNzLmVudi5BTlRIUk9QSUNfQkFTRV9VUkw7XG4gICAgaWYgKGFudGhyb3BpY0Jhc2VVcmwpIHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICAgIGxhYmVsOiAnQW50aHJvcGljIGJhc2UgVVJMJyxcbiAgICAgICAgdmFsdWU6IGFudGhyb3BpY0Jhc2VVcmxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSBlbHNlIGlmIChhcGlQcm92aWRlciA9PT0gJ2JlZHJvY2snKSB7XG4gICAgY29uc3QgYmVkcm9ja0Jhc2VVcmwgPSBwcm9jZXNzLmVudi5CRURST0NLX0JBU0VfVVJMO1xuICAgIGlmIChiZWRyb2NrQmFzZVVybCkge1xuICAgICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgICAgbGFiZWw6ICdCZWRyb2NrIGJhc2UgVVJMJyxcbiAgICAgICAgdmFsdWU6IGJlZHJvY2tCYXNlVXJsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgIGxhYmVsOiAnQVdTIHJlZ2lvbicsXG4gICAgICB2YWx1ZTogZ2V0QVdTUmVnaW9uKClcbiAgICB9KTtcbiAgICBpZiAoaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfU0tJUF9CRURST0NLX0FVVEgpKSB7XG4gICAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgICB2YWx1ZTogJ0FXUyBhdXRoIHNraXBwZWQnXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoYXBpUHJvdmlkZXIgPT09ICd2ZXJ0ZXgnKSB7XG4gICAgY29uc3QgdmVydGV4QmFzZVVybCA9IHByb2Nlc3MuZW52LlZFUlRFWF9CQVNFX1VSTDtcbiAgICBpZiAodmVydGV4QmFzZVVybCkge1xuICAgICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgICAgbGFiZWw6ICdWZXJ0ZXggYmFzZSBVUkwnLFxuICAgICAgICB2YWx1ZTogdmVydGV4QmFzZVVybFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGdjcFByb2plY3QgPSBwcm9jZXNzLmVudi5BTlRIUk9QSUNfVkVSVEVYX1BST0pFQ1RfSUQ7XG4gICAgaWYgKGdjcFByb2plY3QpIHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICAgIGxhYmVsOiAnR0NQIHByb2plY3QnLFxuICAgICAgICB2YWx1ZTogZ2NwUHJvamVjdFxuICAgICAgfSk7XG4gICAgfVxuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ0RlZmF1bHQgcmVnaW9uJyxcbiAgICAgIHZhbHVlOiBnZXREZWZhdWx0VmVydGV4UmVnaW9uKClcbiAgICB9KTtcbiAgICBpZiAoaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfU0tJUF9WRVJURVhfQVVUSCkpIHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICAgIHZhbHVlOiAnR0NQIGF1dGggc2tpcHBlZCdcbiAgICAgIH0pO1xuICAgIH1cbiAgfSBlbHNlIGlmIChhcGlQcm92aWRlciA9PT0gJ2ZvdW5kcnknKSB7XG4gICAgY29uc3QgZm91bmRyeUJhc2VVcmwgPSBwcm9jZXNzLmVudi5BTlRIUk9QSUNfRk9VTkRSWV9CQVNFX1VSTDtcbiAgICBpZiAoZm91bmRyeUJhc2VVcmwpIHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICAgIGxhYmVsOiAnTWljcm9zb2Z0IEZvdW5kcnkgYmFzZSBVUkwnLFxuICAgICAgICB2YWx1ZTogZm91bmRyeUJhc2VVcmxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBmb3VuZHJ5UmVzb3VyY2UgPSBwcm9jZXNzLmVudi5BTlRIUk9QSUNfRk9VTkRSWV9SRVNPVVJDRTtcbiAgICBpZiAoZm91bmRyeVJlc291cmNlKSB7XG4gICAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgICBsYWJlbDogJ01pY3Jvc29mdCBGb3VuZHJ5IHJlc291cmNlJyxcbiAgICAgICAgdmFsdWU6IGZvdW5kcnlSZXNvdXJjZVxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmIChpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9TS0lQX0ZPVU5EUllfQVVUSCkpIHtcbiAgICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICAgIHZhbHVlOiAnTWljcm9zb2Z0IEZvdW5kcnkgYXV0aCBza2lwcGVkJ1xuICAgICAgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGFwaVByb3ZpZGVyID09PSAnbWluaW1heCcpIHtcbiAgICBjb25zdCBlbmRwb2ludCA9IGdldE1pbmlNYXhFbmRwb2ludCgpO1xuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ01pbmlNYXggcmVnaW9uJyxcbiAgICAgIHZhbHVlOiBlbmRwb2ludC5yZWdpb25cbiAgICB9KTtcbiAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgbGFiZWw6ICdNaW5pTWF4IEFudGhyb3BpYyBiYXNlIFVSTCcsXG4gICAgICB2YWx1ZTogcHJvY2Vzcy5lbnYuQU5USFJPUElDX0JBU0VfVVJMIHx8IGVuZHBvaW50LmFudGhyb3BpY0Jhc2VVcmxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBwcm94eVVybCA9IGdldFByb3h5VXJsKCk7XG4gIGlmIChwcm94eVVybCkge1xuICAgIHByb3BlcnRpZXMucHVzaCh7XG4gICAgICBsYWJlbDogJ1Byb3h5JyxcbiAgICAgIHZhbHVlOiBwcm94eVVybFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IG10bHNDb25maWcgPSBnZXRNVExTQ29uZmlnKCk7XG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VYVFJBX0NBX0NFUlRTKSB7XG4gICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgIGxhYmVsOiAnQWRkaXRpb25hbCBDQSBjZXJ0KHMpJyxcbiAgICAgIHZhbHVlOiBwcm9jZXNzLmVudi5OT0RFX0VYVFJBX0NBX0NFUlRTXG4gICAgfSk7XG4gIH1cbiAgaWYgKG10bHNDb25maWcpIHtcbiAgICBpZiAobXRsc0NvbmZpZy5jZXJ0ICYmIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0NMSUVOVF9DRVJUKSB7XG4gICAgICBwcm9wZXJ0aWVzLnB1c2goe1xuICAgICAgICBsYWJlbDogJ21UTFMgY2xpZW50IGNlcnQnLFxuICAgICAgICB2YWx1ZTogcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfQ0xJRU5UX0NFUlRcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAobXRsc0NvbmZpZy5rZXkgJiYgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfQ0xJRU5UX0tFWSkge1xuICAgICAgcHJvcGVydGllcy5wdXNoKHtcbiAgICAgICAgbGFiZWw6ICdtVExTIGNsaWVudCBrZXknLFxuICAgICAgICB2YWx1ZTogcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfQ0xJRU5UX0tFWVxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBwcm9wZXJ0aWVzO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGdldE1vZGVsRGlzcGxheUxhYmVsKG1haW5Mb29wTW9kZWw6IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICBsZXQgbW9kZWxMYWJlbCA9IG1vZGVsRGlzcGxheVN0cmluZyhtYWluTG9vcE1vZGVsKTtcbiAgaWYgKG1haW5Mb29wTW9kZWwgPT09IG51bGwgJiYgaXNDbGF1ZGVBSVN1YnNjcmliZXIoKSkge1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gZ2V0Q2xhdWRlQWlVc2VyRGVmYXVsdE1vZGVsRGVzY3JpcHRpb24oKTtcbiAgICBtb2RlbExhYmVsID0gYCR7Y2hhbGsuYm9sZCgnRGVmYXVsdCcpfSAke2Rlc2NyaXB0aW9ufWA7XG4gIH1cbiAgcmV0dXJuIG1vZGVsTGFiZWw7XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSJ9
