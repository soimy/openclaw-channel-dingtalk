/**
 * DEPRECATED: Use plugin.ts instead
 *
 * This file is maintained for backward compatibility only.
 * It will be removed in v2.0.0.
 *
 * Migration Guide:
 * 1. Plugin-based integration (recommended):
 *    - Use Clawdbot's plugin system directly
 *    - Configuration via ~/.clawdbot/clawdbot.json
 *    - Automatic lifecycle management
 *
 * 2. Testing:
 *    - For manual testing: npm run test:integration
 *    - For unit tests: npm run test
 *    - For local dev: npm run test:watch
 *
 * 3. Configuration:
 *    Instead of ~/.config/dingtalk/credentials.json,
 *    use Clawdbot configuration:
 *    {
 *      "channels": {
 *        "dingtalk": {
 *          "clientId": "your-app-key",
 *          "clientSecret": "your-app-secret",
 *          ...
 *        }
 *      }
 *    }
 *
 * See README.md for complete setup instructions.
 * See AGENT.md for architecture and implementation details.
 */

