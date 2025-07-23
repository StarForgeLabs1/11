const { NodeOperationError } = require('n8n-workflow');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Redis = require('ioredis');

class TikTokMultiTenant {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);
        puppeteer.use(StealthPlugin());
    }

    async execute(context) {
        const tenantId = context.getNodeParameter('tenantId', 0);
        const action = context.getNodeParameter('action', 0);
        const params = context.getNodeParameter('params', 0, {});

        // 获取租户配置
        const tenant = await this.getTenantConfig(tenantId);
        if (!tenant) throw new NodeOperationError('Invalid tenant config');

        // 初始化浏览器
        const { browser, page } = await this.initBrowser(tenant);

        try {
            let result;
            switch (action) {
                case 'login':
                    result = await this.handleLogin(page, tenant);
                    break;
                case 'post':
                    result = await this.postVideo(page, params);
                    break;
                case 'follow':
                    result = await this.followUser(page, params);
                    break;
                default:
                    throw new NodeOperationError('Unsupported action');
            }

            // 保存更新后的cookies
            await this.saveCookies(tenantId, await page.cookies());

            return [context.helpers.returnJsonArray(result)];
        } finally {
            await browser.close();
        }
    }

    async getTenantConfig(tenantId) {
        return this.redis.hgetall(`tenant:${tenantId}`);
    }

    async initBrowser(tenant) {
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                `--proxy-server=${tenant.proxy}`,
                `--user-agent=${tenant.userAgent}`,
                '--no-sandbox'
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({
            width: parseInt(tenant.width || '1920'),
            height: parseInt(tenant.height || '1080')
        });
        return { browser, page };
    }

    async handleLogin(page, tenant) {
        await page.goto('https://www.tiktok.com/login', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // 注入已有cookies
        if (tenant.cookies) {
            await page.setCookie(...JSON.parse(tenant.cookies));
            await page.reload();
            return { status: 'session_restored' };
        }

        // 执行登录
        await page.type('input[name="username"]', tenant.username);
        await page.type('input[name="password"]', tenant.password);
        await page.click('button[type="submit"]');

        // 等待登录成功
        await page.waitForSelector('div[data-e2e="user-avatar"]', {
            timeout: 30000
        });

        return { status: 'login_success' };
    }

    async saveCookies(tenantId, cookies) {
        await this.redis.hset(
            `tenant:${tenantId}`,
            'cookies',
            JSON.stringify(cookies)
        );
    }
}

module.exports = TikTokMultiTenant;