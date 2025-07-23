# n8n多租户TikTok自动化系统

## 项目结构
```
n8n-tiktok-multitenant/
├── nodes/
│   ├── TikTokMultiTenant/
│   │   ├── TikTokMultiTenant.node.js
│   │   └── TikTokMultiTenant.node.json
│   └── TenantManager/
│       ├── TenantManager.node.js
│       └── TenantManager.node.json
├── config/
│   ├── tenants.json
│   └── redis.conf
├── workflows/
│   ├── tiktok-login-workflow.json
│   ├── tiktok-post-workflow.json
│   └── tenant-management-workflow.json
├── docker-compose.yml
├── package.json
└── README.md
```

## 1. TikTok多租户节点实现

### nodes/TikTokMultiTenant/TikTokMultiTenant.node.js
```javascript
const { IExecuteFunctions } = require('n8n-core');
const {
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
    NodeOperationError,
} = require('n8n-workflow');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Redis = require('ioredis');
const { readFileSync } = require('fs');

// 使用Stealth插件防止被检测
puppeteer.use(StealthPlugin());

class TikTokMultiTenant implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'TikTok Multi-Tenant',
        name: 'tikTokMultiTenant',
        icon: 'file:tiktok.svg',
        group: ['social'],
        version: 1,
        description: '多租户TikTok自动化操作节点',
        defaults: {
            name: 'TikTok Multi-Tenant',
        },
        inputs: ['main'],
        outputs: ['main'],
        credentials: [],
        properties: [
            {
                displayName: '租户ID',
                name: 'tenantId',
                type: 'string',
                default: '',
                required: true,
                description: '租户唯一标识符',
            },
            {
                displayName: '操作类型',
                name: 'action',
                type: 'options',
                options: [
                    {
                        name: '登录',
                        value: 'login',
                    },
                    {
                        name: '发布视频',
                        value: 'post',
                    },
                    {
                        name: '关注用户',
                        value: 'follow',
                    },
                    {
                        name: '点赞视频',
                        value: 'like',
                    },
                    {
                        name: '评论',
                        value: 'comment',
                    },
                ],
                default: 'login',
                required: true,
            },
            // 登录参数
            {
                displayName: '用户名',
                name: 'username',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['login'],
                    },
                },
            },
            {
                displayName: '密码',
                name: 'password',
                type: 'string',
                typeOptions: {
                    password: true,
                },
                default: '',
                displayOptions: {
                    show: {
                        action: ['login'],
                    },
                },
            },
            // 发布视频参数
            {
                displayName: '视频文件路径',
                name: 'videoPath',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['post'],
                    },
                },
            },
            {
                displayName: '视频标题',
                name: 'title',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['post'],
                    },
                },
            },
            {
                displayName: '视频描述',
                name: 'description',
                type: 'string',
                typeOptions: {
                    rows: 4,
                },
                default: '',
                displayOptions: {
                    show: {
                        action: ['post'],
                    },
                },
            },
            // 关注参数
            {
                displayName: '目标用户名',
                name: 'targetUsername',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['follow'],
                    },
                },
            },
            // 点赞参数
            {
                displayName: '视频URL',
                name: 'videoUrl',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['like'],
                    },
                },
            },
            // 评论参数
            {
                displayName: '评论内容',
                name: 'commentText',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        action: ['comment'],
                    },
                },
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];

        // 初始化Redis连接
        const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        for (let i = 0; i < items.length; i++) {
            try {
                const tenantId = this.getNodeParameter('tenantId', i) as string;
                const action = this.getNodeParameter('action', i) as string;

                // 获取租户配置
                const tenant = await this.getTenantConfig(redis, tenantId);
                if (!tenant) {
                    throw new NodeOperationError(this.getNode(), `租户 ${tenantId} 配置不存在`);
                }

                // 初始化浏览器实例
                const { browser, page } = await this.initBrowser(tenant);

                try {
                    let result;
                    switch (action) {
                        case 'login':
                            result = await this.handleLogin(page, tenant, i);
                            break;
                        case 'post':
                            result = await this.postVideo(page, i);
                            break;
                        case 'follow':
                            result = await this.followUser(page, i);
                            break;
                        case 'like':
                            result = await this.likeVideo(page, i);
                            break;
                        case 'comment':
                            result = await this.commentVideo(page, i);
                            break;
                        default:
                            throw new NodeOperationError(this.getNode(), `不支持的操作类型: ${action}`);
                    }

                    // 保存更新后的cookies
                    await this.saveCookies(redis, tenantId, await page.cookies());

                    returnData.push({
                        json: {
                            tenantId,
                            action,
                            result,
                            timestamp: new Date().toISOString(),
                        },
                    });
                } finally {
                    await browser.close();
                }
            } catch (error) {
                throw new NodeOperationError(this.getNode(), `执行失败: ${error.message}`);
            }
        }

        await redis.disconnect();
        return [returnData];
    }

    private async getTenantConfig(redis: Redis, tenantId: string) {
        const config = await redis.hgetall(`tenant:${tenantId}`);
        return Object.keys(config).length > 0 ? config : null;
    }

    private async initBrowser(tenant: any) {
        const browserArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ];

        // 如果配置了代理，添加代理参数
        if (tenant.proxy) {
            browserArgs.push(`--proxy-server=${tenant.proxy}`);
        }

        // 设置用户代理
        if (tenant.userAgent) {
            browserArgs.push(`--user-agent=${tenant.userAgent}`);
        }

        const browser = await puppeteer.launch({
            headless: process.env.NODE_ENV === 'production',
            args: browserArgs,
            ignoreHTTPSErrors: true,
            defaultViewport: {
                width: parseInt(tenant.width || '1920'),
                height: parseInt(tenant.height || '1080'),
            },
        });

        const page = await browser.newPage();

        // 设置额外的反检测措施
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // 如果有保存的cookies，恢复会话
        if (tenant.cookies) {
            try {
                const cookies = JSON.parse(tenant.cookies);
                await page.setCookie(...cookies);
            } catch (error) {
                console.warn('恢复cookies失败:', error.message);
            }
        }

        return { browser, page };
    }

    private async handleLogin(page: any, tenant: any, itemIndex: number) {
        const username = this.getNodeParameter('username', itemIndex) as string || tenant.username;
        const password = this.getNodeParameter('password', itemIndex) as string || tenant.password;

        await page.goto('https://www.tiktok.com/login', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // 等待登录表单加载
        await page.waitForSelector('input[name="username"]', { timeout: 30000 });

        // 输入用户名和密码
        await page.type('input[name="username"]', username, { delay: 100 });
        await page.type('input[name="password"]', password, { delay: 100 });

        // 点击登录按钮
        await page.click('button[type="submit"]');

        // 等待登录成功或失败
        try {
            await page.waitForSelector('div[data-e2e="user-avatar"]', { timeout: 30000 });
            return { status: 'success', message: '登录成功' };
        } catch (error) {
            return { status: 'failed', message: '登录失败，请检查用户名和密码' };
        }
    }

    private async postVideo(page: any, itemIndex: number) {
        const videoPath = this.getNodeParameter('videoPath', itemIndex) as string;
        const title = this.getNodeParameter('title', itemIndex) as string;
        const description = this.getNodeParameter('description', itemIndex) as string;

        await page.goto('https://www.tiktok.com/upload', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // 上传视频文件
        const fileInput = await page.$('input[type="file"]');
        await fileInput.uploadFile(videoPath);

        // 等待视频处理完成
        await page.waitForSelector('div[data-e2e="upload-complete"]', { timeout: 120000 });

        // 填写标题和描述
        if (title) {
            await page.type('div[data-e2e="video-title"]', title);
        }

        if (description) {
            await page.type('div[data-e2e="video-caption"]', description);
        }

        // 发布视频
        await page.click('button[data-e2e="publish-button"]');

        // 等待发布完成
        await page.waitForSelector('div[data-e2e="publish-success"]', { timeout: 60000 });

        return { status: 'success', message: '视频发布成功' };
    }

    private async followUser(page: any, itemIndex: number) {
        const targetUsername = this.getNodeParameter('targetUsername', itemIndex) as string;

        await page.goto(`https://www.tiktok.com/@${targetUsername}`, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // 查找并点击关注按钮
        const followButton = await page.$('button[data-e2e="follow-button"]');
        if (followButton) {
            await followButton.click();
            await page.waitForTimeout(2000);
            return { status: 'success', message: `成功关注用户 @${targetUsername}` };
        } else {
            return { status: 'failed', message: '未找到关注按钮' };
        }
    }

    private async likeVideo(page: any, itemIndex: number) {
        const videoUrl = this.getNodeParameter('videoUrl', itemIndex) as string;

        await page.goto(videoUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // 查找并点击点赞按钮
        const likeButton = await page.$('button[data-e2e="like-button"]');
        if (likeButton) {
            await likeButton.click();
            await page.waitForTimeout(2000);
            return { status: 'success', message: '视频点赞成功' };
        } else {
            return { status: 'failed', message: '未找到点赞按钮' };
        }
    }

    private async commentVideo(page: any, itemIndex: number) {
        const videoUrl = this.getNodeParameter('videoUrl', itemIndex) as string;
        const commentText = this.getNodeParameter('commentText', itemIndex) as string;

        await page.goto(videoUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // 查找评论输入框
        const commentInput = await page.$('div[data-e2e="comment-input"]');
        if (commentInput) {
            await commentInput.type(commentText);
            
            // 点击发送按钮
            const sendButton = await page.$('button[data-e2e="comment-send"]');
            if (sendButton) {
                await sendButton.click();
                await page.waitForTimeout(2000);
                return { status: 'success', message: '评论发送成功' };
            }
        }

        return { status: 'failed', message: '评论发送失败' };
    }

    private async saveCookies(redis: Redis, tenantId: string, cookies: any[]) {
        await redis.hset(
            `tenant:${tenantId}`,
            'cookies',
            JSON.stringify(cookies),
            'lastUpdate',
            new Date().toISOString()
        );
    }
}

module.exports = { nodeClass: TikTokMultiTenant };
```

### nodes/TikTokMultiTenant/TikTokMultiTenant.node.json
```json
{
    "node": "n8n-nodes-tiktok-multitenant.TikTokMultiTenant",
    "nodeVersion": "1.0.0"
}
```

## 2. 租户管理节点实现

### nodes/TenantManager/TenantManager.node.js
```javascript
const { IExecuteFunctions } = require('n8n-core');
const {
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
    NodeOperationError,
} = require('n8n-workflow');

const Redis = require('ioredis');

class TenantManager implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Tenant Manager',
        name: 'tenantManager',
        icon: 'fa:users',
        group: ['management'],
        version: 1,
        description: '多租户管理节点',
        defaults: {
            name: 'Tenant Manager',
        },
        inputs: ['main'],
        outputs: ['main'],
        properties: [
            {
                displayName: '操作类型',
                name: 'operation',
                type: 'options',
                options: [
                    {
                        name: '添加租户',
                        value: 'add',
                    },
                    {
                        name: '更新租户',
                        value: 'update',
                    },
                    {
                        name: '删除租户',
                        value: 'delete',
                    },
                    {
                        name: '列出租户',
                        value: 'list',
                    },
                    {
                        name: '获取租户信息',
                        value: 'get',
                    },
                ],
                default: 'add',
                required: true,
            },
            {
                displayName: '租户ID',
                name: 'tenantId',
                type: 'string',
                default: '',
                required: true,
                displayOptions: {
                    show: {
                        operation: ['add', 'update', 'delete', 'get'],
                    },
                },
            },
            {
                displayName: '用户名',
                name: 'username',
                type: 'string',
                default: '',
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
            {
                displayName: '密码',
                name: 'password',
                type: 'string',
                typeOptions: {
                    password: true,
                },
                default: '',
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
            {
                displayName: '代理服务器',
                name: 'proxy',
                type: 'string',
                default: '',
                placeholder: 'socks5://proxy.example.com:1080',
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
            {
                displayName: '用户代理',
                name: 'userAgent',
                type: 'string',
                default: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
            {
                displayName: '浏览器宽度',
                name: 'width',
                type: 'number',
                default: 1920,
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
            {
                displayName: '浏览器高度',
                name: 'height',
                type: 'number',
                default: 1080,
                displayOptions: {
                    show: {
                        operation: ['add', 'update'],
                    },
                },
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const items = this.getInputData();
        const returnData: INodeExecutionData[] = [];

        const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        for (let i = 0; i < items.length; i++) {
            try {
                const operation = this.getNodeParameter('operation', i) as string;

                let result;
                switch (operation) {
                    case 'add':
                        result = await this.addTenant(redis, i);
                        break;
                    case 'update':
                        result = await this.updateTenant(redis, i);
                        break;
                    case 'delete':
                        result = await this.deleteTenant(redis, i);
                        break;
                    case 'list':
                        result = await this.listTenants(redis);
                        break;
                    case 'get':
                        result = await this.getTenant(redis, i);
                        break;
                    default:
                        throw new NodeOperationError(this.getNode(), `不支持的操作类型: ${operation}`);
                }

                returnData.push({
                    json: {
                        operation,
                        result,
                        timestamp: new Date().toISOString(),
                    },
                });
            } catch (error) {
                throw new NodeOperationError(this.getNode(), `操作失败: ${error.message}`);
            }
        }

        await redis.disconnect();
        return [returnData];
    }

    private async addTenant(redis: Redis, itemIndex: number) {
        const tenantId = this.getNodeParameter('tenantId', itemIndex) as string;
        const username = this.getNodeParameter('username', itemIndex) as string;
        const password = this.getNodeParameter('password', itemIndex) as string;
        const proxy = this.getNodeParameter('proxy', itemIndex) as string;
        const userAgent = this.getNodeParameter('userAgent', itemIndex) as string;
        const width = this.getNodeParameter('width', itemIndex) as number;
        const height = this.getNodeParameter('height', itemIndex) as number;

        const tenant = {
            id: tenantId,
            username,
            password,
            proxy,
            userAgent,
            width: width.toString(),
            height: height.toString(),
            createdAt: new Date().toISOString(),
            status: 'active',
        };

        await redis.hmset(`tenant:${tenantId}`, tenant);

        return {
            status: 'success',
            message: `租户 ${tenantId} 添加成功`,
            tenant: { ...tenant, password: '***' }, // 隐藏密码
        };
    }

    private async updateTenant(redis: Redis, itemIndex: number) {
        const tenantId = this.getNodeParameter('tenantId', itemIndex) as string;

        // 检查租户是否存在
        const exists = await redis.exists(`tenant:${tenantId}`);
        if (!exists) {
            throw new NodeOperationError(this.getNode(), `租户 ${tenantId} 不存在`);
        }

        const updates: any = {
            updatedAt: new Date().toISOString(),
        };

        // 只更新提供的字段
        const fields = ['username', 'password', 'proxy', 'userAgent', 'width', 'height'];
        for (const field of fields) {
            try {
                const value = this.getNodeParameter(field, itemIndex);
                if (value !== undefined && value !== '') {
                    updates[field] = field === 'width' || field === 'height' ? value.toString() : value;
                }
            } catch (error) {
                // 字段未提供，跳过
            }
        }

        await redis.hmset(`tenant:${tenantId}`, updates);

        return {
            status: 'success',
            message: `租户 ${tenantId} 更新成功`,
            updates: { ...updates, password: updates.password ? '***' : undefined },
        };
    }

    private async deleteTenant(redis: Redis, itemIndex: number) {
        const tenantId = this.getNodeParameter('tenantId', itemIndex) as string;

        const deleted = await redis.del(`tenant:${tenantId}`);
        
        if (deleted === 0) {
            throw new NodeOperationError(this.getNode(), `租户 ${tenantId} 不存在`);
        }

        return {
            status: 'success',
            message: `租户 ${tenantId} 删除成功`,
        };
    }

    private async listTenants(redis: Redis) {
        const keys = await redis.keys('tenant:*');
        const tenants = [];

        for (const key of keys) {
            const tenant = await redis.hgetall(key);
            if (tenant.password) {
                tenant.password = '***'; // 隐藏密码
            }
            tenants.push(tenant);
        }

        return {
            status: 'success',
            count: tenants.length,
            tenants,
        };
    }

    private async getTenant(redis: Redis, itemIndex: number) {
        const tenantId = this.getNodeParameter('tenantId', itemIndex) as string;

        const tenant = await redis.hgetall(`tenant:${tenantId}`);
        
        if (Object.keys(tenant).length === 0) {
            throw new NodeOperationError(this.getNode(), `租户 ${tenantId} 不存在`);
        }

        if (tenant.password) {
            tenant.password = '***'; // 隐藏密码
        }

        return {
            status: 'success',
            tenant,
        };
    }
}

module.exports = { nodeClass: TenantManager };
```

### nodes/TenantManager/TenantManager.node.json
```json
{
    "node": "n8n-nodes-tiktok-multitenant.TenantManager",
    "nodeVersion": "1.0.0"
}
```

## 3. 配置文件

### package.json
```json
{
  "name": "n8n-nodes-tiktok-multitenant",
  "version": "1.0.0",
  "description": "n8n多租户TikTok自动化节点",
  "main": "index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "format": "prettier --write .",
    "lint": "eslint ."
  },
  "files": [
    "dist"
  ],
  "n8n": {
    "n8nNodesApiVersion": 1,
    "nodes": [
      "dist/nodes/TikTokMultiTenant/TikTokMultiTenant.node.js",
      "dist/nodes/TenantManager/TenantManager.node.js"
    ]
  },
  "keywords": [
    "n8n",
    "tiktok",
    "automation",
    "multi-tenant"
  ],
  "author": "Your Name",
  "license": "MIT",
  "dependencies": {
    "n8n-core": "^0.116.0",
    "n8n-workflow": "^0.107.0",
    "puppeteer-extra": "^3.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "ioredis": "^5.3.2"
  },
  "devDependencies": {
    "@types/node": "^18.0.0",
    "typescript": "^4.7.4",
    "prettier": "^2.7.1",
    "eslint": "^8.20.0"
  }
}
```

### docker-compose.yml
```yaml
version: '3.8'

services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    environment:
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=n8n
      - DB_POSTGRESDB_USER=n8n
      - DB_POSTGRESDB_PASSWORD=n8n
      - REDIS_URL=redis://redis:6379
      - N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/custom
      - EXECUTIONS_PROCESS=main
      - EXECUTIONS_MODE=queue
      - QUEUE_BULL_REDIS_HOST=redis
      - QUEUE_BULL_REDIS_PORT=6379
    volumes:
      - n8n_data:/home/node/.n8n
      - ./nodes:/home/node/.n8n/custom/nodes
      - ./workflows:/home/node/.n8n/workflows
      - ./uploads:/tmp/uploads
    depends_on:
      - postgres
      - redis
    networks:
      - n8n-network

  postgres:
    image: postgres:13
    restart: unless-stopped
    environment:
      - POSTGRES_USER=n8n
      - POSTGRES_PASSWORD=n8n
      - POSTGRES_DB=n8n
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - n8n-network

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    networks:
      - n8n-network

  browserless:
    image: browserless/chrome:latest
    restart: unless-stopped
    environment:
      - MAX_CONCURRENT_SESSIONS=10
      - MAX_QUEUE_LENGTH=100
      - CONNECTION_TIMEOUT=60000
    ports:
      - "3000:3000"
    networks:
      - n8n-network

volumes:
  n8n_data:
  postgres_data:
  redis_data:

networks:
  n8n-network:
    driver: bridge
```

### config/tenants.json
```json
[
  {
    "id": "tenant1",
    "username": "your_tiktok_username1",
    "password": "your_tiktok_password1",
    "proxy": "socks5://proxy1.example.com:1080",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "width": "1920",
    "height": "1080",
    "status": "active"
  },
  {
    "id": "tenant2",
    "username": "your_tiktok_username2",
    "password": "your_tiktok_password2",
    "proxy": "socks5://proxy2.example.com:1080",
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15",
    "width": "1280",
    "height": "720",
    "status": "active"
  }
]