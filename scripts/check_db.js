const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getDb } = require(path.join(__dirname, '../dist/storage/db'));

async function checkDatabase() {
  const db = getDb();
  try {
    const hasPosts = await db.schema.hasTable('posts');
    const hasComments = await db.schema.hasTable('comments');
    const hasProfiles = await db.schema.hasTable('user_profiles');

    let postCount = 0;
    let commentCount = 0;
    let profileCount = 0;

    if (hasPosts) {
      const [{ count }] = await db('posts').count('* as count');
      postCount = Number(count);
    }
    if (hasComments) {
      const [{ count }] = await db('comments').count('* as count');
      commentCount = Number(count);
    }
    if (hasProfiles) {
      const [{ count }] = await db('user_profiles').count('* as count');
      profileCount = Number(count);
    }

    console.log('\n================ 数据库数据统计 ================');
    console.log(`📊 微博总数: ${postCount} 条 | 评论总数: ${commentCount} 条 | 博主资料: ${profileCount} 条`);
    console.log('================================================\n');

    if (hasPosts && postCount > 0) {
      const limit = 20;
      const recentPosts = await db('posts')
        .select('id', 'user_name', 'time', 'content')
        .orderBy('created_at', 'desc')
        .limit(limit);

      console.log(`📌 最新 ${recentPosts.length} 条微博清单 (按入库倒序):`);
      recentPosts.forEach((p, idx) => {
        const text = (p.content || '').replace(/\s+/g, ' ').substring(0, 50);
        console.log(`[${idx + 1}] ${p.user_name} | ${p.time} | ID: ${p.id}`);
        console.log(`    正文: ${text}...`);
      });
      console.log('');
    }
  } catch (err) {
    console.error('❌ 查询数据库失败:', err);
  } finally {
    await db.destroy();
  }
}

checkDatabase();
