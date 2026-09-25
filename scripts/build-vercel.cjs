const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = ['index', 'programs', 'scores', 'preparation', 'timeline', 'application', 'materials', 'updates', 'sources'];

async function build(outputDirectory = path.join(root, 'public')) {
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const page of pages) {
    const filename = `${page}.html`;
    const html = (await fs.readFile(path.join(root, filename), 'utf8'))
      .replace('<body ', '<body data-hosting="vercel" ')
      .replaceAll('本地 Node.js 服务运行时才会读取实时快照。', '在线通知在访问时检查更新；可点击立即同步重新抓取。')
      .replaceAll('电脑关机期间无法抓取；下次启动后会立即补查。', '在线版按访问触发更新；临时缓存可能重置，无人访问时不持续抓取。')
      .replaceAll('本地 Node.js 服务按后台配置的刷新周期检查', '在线通知服务在访问时检查是否到期，或在点击立即同步时抓取')
      .replaceAll('服务运行时默认每 10 分钟抓取，瞬时失败重试一次；页面每分钟读取快照，切回页面时立即恢复。电脑关机、休眠或断网期间无法保证准时获取，恢复后补查。', '页面打开期间每分钟检查，数据超过 10 分钟时尝试抓取；也可手动同步。无人访问时不持续抓取，临时缓存可能随实例重置。')
      .replaceAll('下次自动检查', '更新方式')
      .replaceAll('本地服务', '在线服务')
      .replaceAll('本地 Node.js 服务', '在线通知服务')
      .replaceAll('本地更新服务', '在线通知服务');
    await fs.writeFile(path.join(outputDirectory, filename), html, 'utf8');
  }
  for (const filename of ['app.js', 'styles.css']) {
    await fs.copyFile(path.join(root, filename), path.join(outputDirectory, filename));
  }
}

module.exports = { build };
if (require.main === module) build(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
