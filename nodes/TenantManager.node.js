const { NodeOperationError } = require('n8n-workflow');
const Redis = require('ioredis');

class TenantManager {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);
    }

    async execute(context) {
        const operation = context.getNodeParameter('operation', 0);

        switch (operation) {
            case 'add':
                return this.addTenant(context);
            case 'update':
                return this.updateTenant(context);
            case 'list':
                return this.listTenants(context);
            default:
                throw new NodeOperationError('Unsupported operation');
        }
    }

    async addTenant(context) {
        const items = context.getInputData();
        const results = [];

        for (let i = 0; i < items.length; i++) {
            const tenant = {
                id: context.getNodeParameter('tenantId', i),
                username: context.getNodeParameter('username', i),
                password: context.getNodeParameter('password', i),
                proxy: context.getNodeParameter('proxy', i),
                userAgent: context.getNodeParameter('userAgent', i),
                width: context.getNodeParameter('width', i, '1920'),
                height: context.getNodeParameter('height', i, '1080')
            };

            await this.redis.hmset(`tenant:${tenant.id}`, tenant);
            results.push({ id: tenant.id, status: 'added' });
        }

        return [context.helpers.returnJsonArray(results)];
    }

    async listTenants(context) {
        const keys = await this.redis.keys('tenant:*');
        const tenants = await Promise.all(
            keys.map(key => this.redis.hgetall(key))
        );
        return [context.helpers.returnJsonArray(tenants)];
    }
}

module.exports = TenantManager;