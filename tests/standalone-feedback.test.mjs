import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createStandaloneAuth } from '../scripts/standalone-auth.mjs';
import { createFeedbackService } from '../scripts/standalone-feedback.mjs';

const origin = 'https://example.test';
const png = { type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6GZgAAAAASUVORK5CYII=' };

function request(path = '', { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  return new Request(origin + '/api/feedback' + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function setup(t) {
  const db = openLocalD1();
  t.after(() => db.close());
  const auth = await createStandaloneAuth(db);
  await db.exec(await readFile(new URL('../drizzle/0003_feedback.sql', import.meta.url), 'utf8'));
  const cookies = [];
  for (const username of ['牌手甲', '牌手乙']) {
    const response = await auth.handle(new Request(origin + '/api/auth/register', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'feedback-test-password' })
    }));
    assert.equal(response.status, 201);
    cookies.push(response.headers.get('Set-Cookie').split(';')[0]);
  }
  return { db, auth, cookies, service: createFeedbackService(db, auth) };
}

test('feedback authenticates readers and images, keeps identity server-side and supports cross-account replies', async t => {
  const { service, cookies } = await setup(t);
  const body = { text: '移动端关闭键\n第二行', images: [png], requestId: randomUUID(), author_id: 'forged' };
  assert.equal((await service.handle(request())).status, 401);
  assert.equal((await service.handle(request('', { body, headers: { 'oai-authenticated-user-id': 'fake' } }))).status, 401);
  const saved = await service.handle(request('', { cookie: cookies[0], body }));
  assert.equal(saved.status, 201);
  const { post } = await saved.json();
  assert.equal(post.author.username, '牌手甲');
  assert.notEqual(post.author.id, 'forged');
  const imagePath = post.images[0].url.slice('/api/feedback'.length);
  assert.equal((await service.handle(request(imagePath))).status, 401);
  const image = await service.handle(request(imagePath, { cookie: cookies[1] }));
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png.data, 'base64'));
  const listed = await (await service.handle(request('', { cookie: cookies[1] }))).json();
  assert.equal(listed.viewer.username, '牌手乙');
  assert.equal(listed.posts[0].id, post.id);
  const replyBody = { text: '<script>文字原样保存</script>', requestId: randomUUID() };
  const reply = await service.handle(request('/' + post.id + '/replies', { cookie: cookies[1], body: replyBody }));
  assert.equal(reply.status, 201);
  assert.equal((await reply.json()).reply.author.username, '牌手乙');
  const replies = await (await service.handle(request('/' + post.id + '/replies', { cookie: cookies[0] }))).json();
  assert.equal(replies.replies[0].text, replyBody.text);
  assert.equal((await (await service.handle(request('', { cookie: cookies[0] }))).json()).posts[0].replyCount, 1);
});

test('feedback rejects cross-site writes and invalid attachments, and retries posts and replies without duplication', async t => {
  const { db, service, cookies } = await setup(t);
  const cookie = cookies[0];
  const body = { text: '问题', images: [png], requestId: randomUUID() };
  assert.equal((await service.handle(request('', { cookie, body, headers: { Origin: 'https://attacker.test' } }))).status, 403);
  assert.equal((await service.handle(request('', { cookie, body, headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status, 403);
  assert.equal((await service.handle(request('', { cookie, body: { ...body, images: [{ type: 'image/png', data: Buffer.from('<svg/>').toString('base64') }] } }))).status, 400);
  assert.equal((await service.handle(request('', { cookie, body: { ...body, images: Array(4).fill(png) } }))).status, 400);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM feedback_posts').first()).n, 0);
  const responses = await Promise.all([service.handle(request('', { cookie, body })), service.handle(request('', { cookie, body }))]);
  const posts = await Promise.all(responses.map(response => response.json()));
  assert.equal(posts[0].post.id, posts[1].post.id);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM feedback_images').first()).n, 1);
  const replyBody = { text: '回复', requestId: randomUUID() };
  const path = '/' + posts[0].post.id + '/replies';
  const replies = await Promise.all([service.handle(request(path, { cookie, body: replyBody })), service.handle(request(path, { cookie, body: replyBody }))]);
  assert.ok(replies.every(response => response.ok));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM feedback_replies').first()).n, 1);
  assert.equal((await service.handle(request('/999999/replies', { cookie, body: replyBody }))).status, 404);
});

test('feedback cursor pages keep newest posts first and replies chronological', async t => {
  const { db, service, cookies, auth } = await setup(t);
  const cookie = cookies[0];
  const account = await auth.currentAccount(request('', { cookie }));
  for (let index = 0; index < 23; index++) {
    await db.prepare('INSERT INTO feedback_posts(author_id,body,request_id,created_at) VALUES (?,?,?,?)')
      .bind(account.id, 'Post ' + index, randomUUID(), Date.now()).run();
  }
  const first = await (await service.handle(request('', { cookie }))).json();
  const second = await (await service.handle(request('?before=' + first.nextBefore, { cookie }))).json();
  assert.equal(first.posts.length, 20);
  assert.equal(second.posts.length, 3);
  assert.ok(first.posts[0].id > first.posts.at(-1).id);
  assert.ok(second.posts[0].id < first.posts.at(-1).id);
  for (let index = 0; index < 33; index++) {
    await db.prepare('INSERT INTO feedback_replies(post_id,author_id,body,request_id,created_at) VALUES (?,?,?,?,?)')
      .bind(first.posts[0].id, account.id, 'Reply ' + index, randomUUID(), Date.now()).run();
  }
  const path = '/' + first.posts[0].id + '/replies';
  const replies = await (await service.handle(request(path, { cookie }))).json();
  const tail = await (await service.handle(request(path + '?after=' + replies.nextAfter, { cookie }))).json();
  assert.equal(replies.replies.length, 30);
  assert.equal(tail.replies.length, 3);
  assert.ok(tail.replies[0].id > replies.replies.at(-1).id);
  assert.equal((await service.handle(request('?before=-1', { cookie }))).status, 400);
});
