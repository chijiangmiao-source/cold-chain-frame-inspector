// 等待 web 服务就绪后再运行验收测试（compose 内 nginx 启动需要一点时间）
const url = process.env.BASE_URL || 'http://web:80';
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      console.log(`web 服务已就绪：${url}`);
      process.exit(0);
    }
  } catch {
    // 尚未就绪，继续等待
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.error(`等待 ${url} 超时`);
process.exit(1);
