# n8n多租户TikTok自动化系统

## 系统介绍

这是一个基于n8n的多租户TikTok自动化系统，支持多账号管理、视频发布、点赞、评论等功能，并通过Redis存储租户配置，使用Browserless提供无头浏览器环境。

## 部署步骤

### 1. 环境要求
- Docker及Docker Compose
- Node.js 16+
- Redis 7+

### 2. 配置租户

编辑`config/tenants.json`文件添加租户信息：
```json
[
  {
    "id": "tenant1",
    "username": "your_tiktok_username",
    "password": "your_tiktok_password",
    "proxy": "socks5://proxy.example.com:1080",
    "userAgent": "Mozilla/5.0...",
    "width": "1920",
    "height": "1080"
  }
]
```

### 3. 启动服务

```bash
docker-compose up -d
```

## 使用说明

1. 访问n8n界面: http://localhost:5678
2. 导入自定义节点: 将`nodes`目录下的文件复制到n8n的自定义节点目录
3. 创建工作流并使用以下节点:
   - **Tenant Manager**: 管理租户配置
   - **TikTok Multi-Tenant**: 执行TikTok自动化操作

## 注意事项
- 确保Redis和Browserless服务正常运行
- 代理配置需根据实际环境调整
- 定期备份租户配置和Redis数据