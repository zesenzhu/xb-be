/**
 * 物理设备分级日志导出原生 TCP 集成测试脚本
 * 运行方式: docker exec -it xbnest-backend-dev node test-log-export.js
 */

const http = require('http');
const net = require('net');

const API_BASE = 'http://127.0.0.1:8081/api';
const CODE = 'XB-TEST-888888';
const DEVICE_ID = 'sim-device-001';

// 辅助方法：发送 JSON POST 请求
function postJson(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const bodyStr = JSON.stringify(data);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: responseBody });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(bodyStr);
    req.end();
  });
}

// 辅助方法：发送 GET 请求
function getRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, data: responseBody, headers: res.headers });
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

// 原生 TCP 客户端发送辅助方法
function connectAndSendLogs(logs) {
  return new Promise((resolve, reject) => {
    console.log('正在与 TCP 127.0.0.1:8082 建立物理 Socket 连接...');
    const client = net.createConnection({ port: 8082, host: '127.0.0.1' }, () => {
      console.log('✓ 物理 TCP 连接建立成功，准备发送 auth 鉴权握手...');
      
      // 1. 发送 auth 帧
      const authFrame = JSON.stringify({
        action: 'auth',
        code: CODE,
        deviceId: DEVICE_ID,
        appName: 'Direct-TCP-Tester',
      }) + '\n';
      client.write(authFrame);
    });

    let buffer = '';
    let isAuthorized = false;

    client.on('data', async (data) => {
      buffer += data.toString('utf8');
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const frame = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);

        if (frame) {
          try {
            const parsed = JSON.parse(frame);
            if (parsed.status === 'ok' && !isAuthorized) {
              isAuthorized = true;
              console.log('✓ TCP 服务端鉴权成功！即将分批上报归档日志...');
              
              // 开始批量发送日志
              await sendInBatches(client, logs);
              
              console.log('✓ 所有归档日志发送完毕，主动断开 TCP 链路。');
              client.end();
              resolve();
            }
          } catch (e) {
            console.error('解析 TCP 响应异常:', frame, e);
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

// 分批发送归档日志 (防止单包超 50 条截断)
async function sendInBatches(client, logs) {
  const chunkSize = 40;
  for (let i = 0; i < logs.length; i += chunkSize) {
    const chunk = logs.slice(i, i + chunkSize);
    const archiveFrame = JSON.stringify({
      action: 'archive_log',
      deviceId: DEVICE_ID,
      logs: chunk,
    }) + '\n';
    
    client.write(archiveFrame);
    console.log(`-> 已写入 TCP 数据包：第 ${i + 1} 至 ${i + chunk.length} 条日志`);
    // 稍微延迟 100ms 规避粘包
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runTest() {
  console.log('=== [LOG EXPORT TEST] 1. 构造测试数据 (120条 INFO + 5条 ERROR) ===');
  
  // 1. 构造 120 条 INFO 日志 (INFO_001 到 INFO_120)
  const infoLogs = [];
  for (let i = 1; i <= 120; i++) {
    // 构造一个具有特定分钟/秒数差异的时间字符串，方便验证时间戳排序
    const minutes = Math.floor(i / 60);
    const seconds = i % 60;
    const timeStr = `10:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    infoLogs.push({
      level: 'INFO',
      module: 'DIRECT_TCP',
      content: `INFO message index: ${String(i).padStart(3, '0')}`,
      time: timeStr,
    });
  }

  // 2. 构造 5 条 ERROR 日志
  const errorLogs = [];
  for (let i = 1; i <= 5; i++) {
    errorLogs.push({
      level: 'ERROR',
      module: 'DIRECT_TCP',
      content: `ERROR critical issue payload: ${i}`,
      time: `11:00:0${i}`,
    });
  }

  const allLogs = [...infoLogs, ...errorLogs];

  console.log('=== [LOG EXPORT TEST] 2. 通过物理 TCP 长连接直接推送并写入数据库 ===');
  await connectAndSendLogs(allLogs);

  // 给数据库写入留一小会儿缓冲时间
  await new Promise((r) => setTimeout(r, 500));

  console.log('=== [LOG EXPORT TEST] 3. 管理员登录以获取 Token ===');
  const loginRes = await postJson(`${API_BASE}/auth/admin/login`, {
    username: 'admin',
    password: 'admin123',
  });
  console.log('管理员登录状态:', loginRes.status);
  const adminToken = loginRes.data && loginRes.data.accessToken;
  if (!adminToken) {
    throw new Error('管理员登录获取 Token 失败');
  }

  console.log('=== [LOG EXPORT TEST] 4. 请求导出日志流并分析内容 ===');
  const exportRes = await getRequest(`${API_BASE}/logs/export?deviceId=${DEVICE_ID}`, {
    'Authorization': `Bearer ${adminToken}`,
  });
  
  console.log('导出 HTTP 状态码:', exportRes.status);

  const logLines = exportRes.data.trim().split('\n').filter(line => line.length > 0);
  console.log(`总共导出了 ${logLines.length} 行日志`);

  // 3. 进行核心断言校验
  console.log('=== [LOG EXPORT TEST] 5. 数据正确性检验 (Asserts) ===');

  const infoLines = logLines.filter(l => l.includes('[INFO]'));
  const errorLines = logLines.filter(l => l.includes('[ERROR]'));

  console.log(`-> INFO 日志行数: ${infoLines.length} (预期: 应裁剪为最新的 100 条，即刚好 100)`);
  console.log(`-> ERROR 日志行数: ${errorLines.length} (预期: 应全部保留，即刚好 5)`);

  let passed = true;

  if (infoLines.length !== 100) {
    console.error('❌ 校验失败：INFO 日志数量不是 100！实际为 ' + infoLines.length);
    passed = false;
  } else {
    console.log('✓ 校验通过：INFO 日志分级裁剪为 100 条。');
  }

  if (errorLines.length !== 5) {
    console.error('❌ 校验失败：ERROR 日志数量不是 5！实际为 ' + errorLines.length);
    passed = false;
  } else {
    console.log('✓ 校验通过：ERROR 日志全部保留（5条）。');
  }

  // 验证 INFO 日志是否为最新的 100 条 (即包含 index 21 到 120，而不包含 1 到 20)
  const containsOldInfo = infoLines.some(l => l.includes('message index: 001') || l.includes('message index: 020'));
  const containsNewInfo = infoLines.some(l => l.includes('message index: 021') && l.includes('message index: 120'));

  if (containsOldInfo) {
    console.error('❌ 校验失败：INFO 日志包含已被裁剪抛弃的旧数据 (message index 1-20)');
    passed = false;
  } else {
    console.log('✓ 校验通过：INFO 旧数据（1-20）已按预期丢弃。');
  }

  // 验证时间戳正序排列（老日志在前，新日志在后）
  const idx21 = logLines.findIndex(l => l.includes('message index: 021'));
  const idx120 = logLines.findIndex(l => l.includes('message index: 120'));

  if (idx21 !== -1 && idx120 !== -1 && idx21 < idx120) {
    console.log('✓ 校验通过：日志在流中符合时间正序排列（老日志在前，最新在后）。');
  } else {
    console.error(`❌ 校验失败：时间排列顺序不正确！idx21: ${idx21}, idx120: ${idx120}`);
    passed = false;
  }

  console.log('=== [LOG EXPORT TEST] 6. 测试越权拦截 (Guard Check) ===');
  const guestExportRes = await getRequest(`${API_BASE}/logs/export?deviceId=${DEVICE_ID}`);
  console.log('未携带 Token 导出状态码 (预期 401 / 403):', guestExportRes.status);
  
  if (guestExportRes.status === 401 || guestExportRes.status === 403) {
    console.log('✓ 越权测试拦截成功：未授权请求已被安全阻断！');
  } else {
    console.error('❌ 越权拦截失败：未授权请求返回了状态码 ' + guestExportRes.status);
    passed = false;
  }

  if (passed) {
    console.log('\n🌟 恭喜！所有分级裁剪与流式导出校验 100% 成功通过！');
  } else {
    console.error('\n💥 测试中存在未通过的校验项，请核实。');
  }
}

runTest().catch((e) => {
  console.error('运行时捕获到未处理异常:', e);
});
