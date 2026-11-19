function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(label, onClick, className = 'button button-quiet') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

async function request(path = '', body) {
  let response;
  try {
    response = await fetch('/api/feedback' + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error('无法连接反馈服务，请重试');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error?.message || '反馈加载失败，请重试');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function prepareScreenshot(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) {
    throw new Error('请选择 15 MB 以内的 JPG、PNG 或 WebP 图片');
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('截图读取失败，请重新选择'));
      image.src = url;
    });
    const ratio = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL('image/jpeg', 0.82);
    const data = preview.split(',')[1];
    if (data.length > 1398104) throw new Error('截图压缩后仍过大，请裁剪后重试');
    return { type: 'image/jpeg', data, preview };
  } finally {
    image.src = '';
    URL.revokeObjectURL(url);
  }
}

export function initFeedbackUI({ container, onLogin, onBack }) {
  let viewer = null;
  let nextBefore = null;
  let loading = false;
  let attachments = [];
  let preparing = false;
  let posting = false;
  let postRequestId = null;
  let pageRevision = 0;

  const heading = element('div', 'feedback-heading');
  heading.append(element('h1', '', '问题反馈'), button('返回', onBack));
  const composer = element('form', 'feedback-composer');
  const label = element('label', 'feedback-label', '遇到了什么问题？');
  label.htmlFor = 'feedback-text';
  const text = element('textarea', 'feedback-text');
  text.id = 'feedback-text';
  text.maxLength = 5000;
  text.rows = 4;
  text.placeholder = '描述遇到的问题、操作步骤…';
  const previews = element('div', 'feedback-previews');
  const file = element('input');
  file.id = 'feedback-file';
  file.type = 'file';
  file.accept = 'image/jpeg,image/png,image/webp';
  file.multiple = true;
  file.hidden = true;
  const upload = button('＋ 截图', () => file.click(), 'button');
  upload.title = '最多 3 张，自动压缩';
  const author = element('span', 'feedback-composer-author');
  const submit = element('button', 'button button-primary', '发布反馈');
  submit.type = 'submit';
  const actions = element('div', 'feedback-compose-actions');
  actions.append(upload, author, submit);
  const error = element('p', 'feedback-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  composer.append(label, text, file, previews, actions, error);
  const login = element('div', 'feedback-login');
  login.append(element('p', '', '登录后可发布反馈、查看历史和回复。'), button('登录', onLogin, 'button button-primary'));
  login.hidden = true;
  const historyHeading = element('div', 'feedback-history-heading');
  historyHeading.append(element('h2', '', '历史反馈'), button('刷新', () => load(true)));
  const history = element('div', 'feedback-history');
  const state = element('p', 'feedback-state');
  state.setAttribute('role', 'status');
  const more = button('更早的反馈', () => load(false), 'button');
  more.hidden = true;
  container.append(heading, composer, login, historyHeading, history, state, more);

  const imageDialog = element('dialog', 'feedback-image-dialog');
  imageDialog.setAttribute('aria-label', '反馈截图');
  const largeImage = element('img');
  largeImage.alt = '反馈截图';
  imageDialog.append(button('×', () => imageDialog.close(), 'button feedback-image-close'), largeImage);
  imageDialog.firstChild.setAttribute('aria-label', '关闭截图');
  imageDialog.addEventListener('click', event => { if (event.target === imageDialog) imageDialog.close(); });
  imageDialog.addEventListener('close', () => largeImage.removeAttribute('src'));
  document.body.append(imageDialog);

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateControls() {
    text.disabled = !viewer || posting;
    upload.disabled = !viewer || posting || preparing || attachments.length >= 3;
    submit.disabled = !viewer || posting || preparing || loading || !text.value.trim() && !attachments.length;
    submit.textContent = posting ? '发布中…' : '发布反馈';
  }

  function requireLogin() {
    viewer = null;
    pageRevision++;
    history.replaceChildren();
    if (imageDialog.open) imageDialog.close();
    login.hidden = false;
    historyHeading.hidden = true;
    more.hidden = true;
    state.textContent = '';
    author.textContent = '';
    updateControls();
  }

  function renderPreviews() {
    previews.replaceChildren();
    attachments.forEach((attachment, index) => {
      const item = element('div', 'feedback-preview');
      const image = element('img');
      image.src = attachment.preview;
      image.alt = `待上传截图 ${index + 1}`;
      const remove = button('×', () => {
        attachments.splice(index, 1);
        postRequestId = null;
        renderPreviews();
        updateControls();
      }, 'feedback-remove-image');
      remove.disabled = posting;
      remove.setAttribute('aria-label', `移除截图 ${index + 1}`);
      item.append(image, remove);
      previews.append(item);
    });
  }

  function authorLine(item) {
    const meta = element('div', 'feedback-meta');
    const id = element('span', 'feedback-user-id', 'ID ' + item.author.id.slice(0, 8));
    id.title = item.author.id;
    const time = element('time', '', new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }));
    time.dateTime = new Date(item.createdAt).toISOString();
    meta.append(element('strong', '', item.author.username), id, time);
    return meta;
  }

  function renderPost(post) {
    const article = element('article', 'feedback-post');
    article.id = 'feedback-post-' + post.id;
    const postHeader = authorLine(post);
    postHeader.append(element('span', 'feedback-number', '#' + post.id));
    article.append(postHeader);
    if (post.text) article.append(element('p', 'feedback-body', post.text));
    if (post.images.length) {
      const images = element('div', 'feedback-images');
      post.images.forEach((attachment, index) => {
        const open = button('', () => {
          largeImage.src = attachment.url;
          imageDialog.showModal();
        }, 'feedback-image-button');
        open.setAttribute('aria-label', `查看反馈 #${post.id} 截图 ${index + 1}`);
        const image = element('img');
        image.src = attachment.url;
        image.alt = `反馈 #${post.id} 截图 ${index + 1}`;
        image.loading = 'lazy';
        open.append(image);
        images.append(open);
      });
      article.append(images);
    }
    const discussion = element('details', 'feedback-discussion');
    const summary = element('summary', '', `回复 · ${post.replyCount}`);
    const replies = element('div', 'feedback-replies');
    const replyError = element('p', 'feedback-error');
    replyError.setAttribute('role', 'alert');
    replyError.hidden = true;
    const replyMore = button('更多回复', () => loadReplies(false));
    replyMore.hidden = true;
    const retry = button('重试', () => loadReplies(true));
    retry.hidden = true;
    const form = element('form', 'feedback-reply-form');
    const input = element('textarea', 'feedback-text');
    input.rows = 2;
    input.maxLength = 2000;
    input.placeholder = '写下回复…';
    input.setAttribute('aria-label', `回复反馈 #${post.id}`);
    const send = element('button', 'button', '回复');
    send.type = 'submit';
    send.disabled = true;
    form.append(input, send);
    discussion.append(summary, replies, replyMore, retry, form, replyError);
    article.append(discussion);
    let loaded = false;
    let nextAfter = null;
    let replyLoading = false;
    let sending = false;
    let replyRequestId = null;
    const replyIds = new Set();

    function appendReply(reply) {
      if (replyIds.has(reply.id)) return;
      replyIds.add(reply.id);
      const row = element('div', 'feedback-reply');
      row.append(authorLine(reply), element('p', 'feedback-body', reply.text));
      replies.append(row);
    }

    async function loadReplies(reset) {
      if (replyLoading) return;
      replyLoading = true;
      send.disabled = true;
      replyMore.disabled = true;
      retry.hidden = true;
      replyError.hidden = true;
      try {
        const result = await request('/' + post.id + '/replies' + (!reset && nextAfter ? '?after=' + nextAfter : ''));
        if (!article.isConnected || !viewer) return;
        if (reset) { replies.replaceChildren(); replyIds.clear(); }
        result.replies.forEach(appendReply);
        nextAfter = result.nextAfter;
        replyMore.hidden = !nextAfter;
        loaded = true;
      } catch (failure) {
        if (failure.status === 401) requireLogin();
        replyError.textContent = failure.message;
        replyError.hidden = false;
        retry.hidden = false;
      } finally {
        replyLoading = false;
        send.disabled = sending || !input.value.trim();
        replyMore.disabled = false;
      }
    }

    discussion.addEventListener('toggle', () => { if (discussion.open && !loaded) void loadReplies(true); });
    input.addEventListener('input', () => { replyRequestId = null; send.disabled = !input.value.trim() || sending || replyLoading; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (sending || replyLoading || !input.value.trim()) return;
      sending = true;
      send.disabled = true;
      input.disabled = true;
      replyError.hidden = true;
      replyRequestId ||= crypto.randomUUID();
      try {
        await request('/' + post.id + '/replies', { text: input.value, requestId: replyRequestId });
        input.value = '';
        replyRequestId = null;
        post.replyCount++;
        summary.textContent = `回复 · ${post.replyCount}`;
        // Reload the thread to keep replies ordered when another user replies concurrently.
        await loadReplies(true);
      } catch (failure) {
        if (failure.status === 401) requireLogin();
        replyError.textContent = failure.message;
        replyError.hidden = false;
      } finally {
        sending = false;
        input.disabled = false;
        send.disabled = !input.value.trim();
      }
    });
    return article;
  }

  async function load(reset) {
    if (loading || posting) return;
    loading = true;
    const revision = ++pageRevision;
    more.disabled = true;
    updateControls();
    state.textContent = '正在加载…';
    try {
      const result = await request(!reset && nextBefore ? '?before=' + nextBefore : '');
      if (revision !== pageRevision) return;
      viewer = result.viewer;
      login.hidden = true;
      historyHeading.hidden = false;
      author.textContent = viewer.username;
      if (reset) history.replaceChildren();
      for (const post of result.posts) history.append(renderPost(post));
      nextBefore = result.nextBefore;
      more.hidden = !nextBefore;
      state.textContent = history.childElementCount ? '' : '还没有反馈';
    } catch (failure) {
      if (failure.status === 401) requireLogin();
      else {
        state.replaceChildren(document.createTextNode(failure.message + ' '), button('重试', () => load(reset)));
      }
    } finally {
      loading = false;
      more.disabled = false;
      updateControls();
    }
  }

  text.addEventListener('input', () => { postRequestId = null; updateControls(); });
  file.addEventListener('change', async () => {
    if (preparing || posting) return;
    preparing = true;
    showError();
    updateControls();
    try {
      const files = Array.from(file.files);
      if (attachments.length + files.length > 3) throw new Error('每条反馈最多 3 张截图');
      const selected = [];
      for (const item of files) selected.push(await prepareScreenshot(item));
      attachments.push(...selected);
      postRequestId = null;
      renderPreviews();
    } catch (failure) {
      showError(failure.message);
    } finally {
      file.value = '';
      preparing = false;
      updateControls();
    }
  });
  composer.addEventListener('submit', async event => {
    event.preventDefault();
    if (!viewer || posting || preparing || loading || !text.value.trim() && !attachments.length) return;
    posting = true;
    showError();
    updateControls();
    renderPreviews();
    postRequestId ||= crypto.randomUUID();
    try {
      const { post } = await request('', {
        text: text.value,
        images: attachments.map(({ type, data }) => ({ type, data })),
        requestId: postRequestId
      });
      text.value = '';
      attachments = [];
      postRequestId = null;
      renderPreviews();
      history.prepend(renderPost(post));
      state.textContent = '';
    } catch (failure) {
      if (failure.status === 401) requireLogin();
      showError(failure.message);
    } finally {
      posting = false;
      renderPreviews();
      updateControls();
    }
  });
  updateControls();
  return { show: () => load(true) };
}
