import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPluginInteractiveHandlers } from 'openclaw/plugin-sdk/plugin-runtime';
import { getChannelRuntimeContext, registerChannelRuntimeContext } from 'openclaw/plugin-sdk/channel-runtime-context';

// Use the installed host's actual registry lifecycle and runtime-context implementation.
// These lifecycle constructors are host internals, not consumer-facing SDK imports.
// Resolve their emitted export aliases by symbol so build hash changes do not break the fixture.
const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve('openclaw/plugin-sdk/plugin-runtime')));
async function hostExport(prefix: string, symbol: string) {
    // OpenClaw 2026.9 emits its dist chunks as `.mjs`; 2026.8 and earlier used `.js`.
    for (const file of readdirSync(hostDist).filter(name => name.startsWith(prefix) && /\.(?:js|mjs)$/.test(name))) {
        const source = readFileSync(join(hostDist, file), 'utf8');
        const alias = source.match(new RegExp(`\\b${symbol} as (\\w+)`))?.[1];
        if (alias) return (await import(pathToFileURL(join(hostDist, file)).href))[alias];
    }
    throw new Error(`Installed OpenClaw host does not export ${symbol}`);
}
const [createEmptyRegistry, setActiveRegistry, withRegistration, createRuntimeChannel] = await Promise.all([
    hostExport('registry-empty-', 'createEmptyPluginRegistry'),
    hostExport('runtime-', 'setActivePluginRegistry'),
    hostExport('runtime-', 'withPluginRegistrationContext'),
    hostExport('runtime-channel-', 'createRuntimeChannel'),
]);

export const CARD_EXTENSION_CONTEXT_KEY = {
    channelId: 'dingtalk', capability: 'dingtalk.card-extensions.transport.v1',
};

export function createCardExtensionHost() {
    let registry = createEmptyRegistry();
    const channelRuntime = createRuntimeChannel();
    setActiveRegistry(registry);
    clearPluginInteractiveHandlers();
    const api = (id = 'consumer') => ({ id, name: `Plugin ${id}`, rootDir: `/plugins/${id}`, runtime: { channel: channelRuntime } });
    return {
        channelRuntime,
        api,
        registrations: () => registry.interactiveHandlers,
        register<T>(run: () => T, pluginId = 'consumer'): T {
            return withRegistration(registry, pluginId, run);
        },
        stage() {
            registry = createEmptyRegistry();
        },
        activate() {
            setActiveRegistry(registry);
        },
        reload() {
            registry = createEmptyRegistry();
            setActiveRegistry(registry);
        },
        bind(accountId: string, context: unknown, abortSignal?: AbortSignal) {
            return registerChannelRuntimeContext({ ...CARD_EXTENSION_CONTEXT_KEY, accountId, channelRuntime, context, abortSignal })!;
        },
        getTransport(accountId: string) {
            return getChannelRuntimeContext({ ...CARD_EXTENSION_CONTEXT_KEY, accountId, channelRuntime }) as any;
        },
    };
}
