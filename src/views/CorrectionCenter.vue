<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useCorrectionStore } from '@/stores/correction'
import DocPill from '@/components/common/DocPill.vue'
import RichEditor from '@/components/doc/RichEditor.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  CORRECTION, CORRECTION_TYPES, correctionTypeLabel,
  correctionStatusLabel, correctionStatusCls, correctionTimelineLabel,
  canClaimCorrection,
  canSubmitCorrectionReview, canRevokeBySubmitter
} from '@/utils/correction'
import { canViewDoc } from '@/utils/permission'
import { reviewStatusLabel } from '@/utils/review'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const accessStore = useAccessStore()
const correctionStore = useCorrectionStore()

const tab = ref('open') // open | claimed | in_review | resolved | mine | all
const busyId = ref('')
const toast = ref('')

// 提交纠错表单
const submitOpen = ref(false)
const fDocId = ref('')
const fType = ref('factual')
const fSummary = ref('')
const fDetail = ref('')
const fExpected = ref('')

// 修订编辑器状态：ticketId -> 是否展开 / 修订正文 / 送审说明
const editing = ref({})
const revBody = ref({})
const revNote = ref({})
// 退回（问题不成立）说明
const dismissing = ref({})
const dismissNote = ref({})

const TABS = [
  { key: CORRECTION.OPEN, label: '待认领' },
  { key: CORRECTION.CLAIMED, label: '修订中' },
  { key: CORRECTION.IN_REVIEW, label: '送审中' },
  { key: CORRECTION.RESOLVED, label: '已修正' },
  { key: 'revoked', label: '已撤回/退回' },
  { key: 'mine', label: '我提交的' },
  { key: 'all', label: '全部' }
]

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

// 提交时仅能关联自己有权查看、且非已退役的文档（受限文档本身看不到，无从发现错误）
const linkableDocs = computed(() =>
  [...kb.docs]
    .filter((d) => canViewDoc(d, auth.user?.id, null, accessStore.grantOf(d.id, auth.user?.id)))
    .filter((d) => !(d.retirement && d.retirement.status === 'approved'))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

const counts = computed(() => {
  const c = { all: correctionStore.tickets.length, mine: 0 }
  for (const s of [CORRECTION.OPEN, CORRECTION.CLAIMED, CORRECTION.IN_REVIEW, CORRECTION.RESOLVED, 'revoked']) {
    c[s] = correctionStore.tickets.filter((t) => t.status === s).length
  }
  c.mine = correctionStore.tickets.filter((t) => t.submittedBy === auth.user?.id).length
  return c
})

const rows = computed(() => {
  let list = [...correctionStore.tickets]
  if (tab.value === 'mine') list = list.filter((t) => t.submittedBy === auth.user?.id)
  else if (tab.value !== 'all') list = list.filter((t) => t.status === tab.value)
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
})

const emptyText = computed(() => ({
  [CORRECTION.OPEN]: '暂无待认领的纠错单',
  [CORRECTION.CLAIMED]: '暂无修订中的纠错单',
  [CORRECTION.IN_REVIEW]: '暂无送审中的纠错修订',
  [CORRECTION.RESOLVED]: '暂无已修正的纠错单',
  revoked: '暂无撤回/退回记录',
  mine: '你还没有提交过纠错',
  all: '暂无纠错单，在文档详情或问答引用处可提交错误反馈'
}[tab.value]))

function grantOf(d) { return accessStore.grantOf(d.id, auth.user?.id) }
function canView(d) { return canViewDoc(d, auth.user?.id, null, grantOf(d)) }
function reviewOf(t) {
  return t.reviewId ? reviewStore.reviews.find((r) => r.id === t.reviewId) : null
}

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 3200)
}

// ---- 提交纠错 ----
function openSubmit(docId) {
  fDocId.value = docId || (route.query.doc || '')
  fType.value = 'factual'
  fSummary.value = ''
  fDetail.value = ''
  fExpected.value = ''
  submitOpen.value = true
}

async function submitCorrection() {
  if (!fDocId.value) { alert('请先选择关联文档'); return }
  if (!fSummary.value.trim()) { alert('请简要描述错误点'); return }
  const res = await correctionStore.createTicket({
    docId: fDocId.value, type: fType.value,
    summary: fSummary.value, detail: fDetail.value, expected: fExpected.value
  }, auth.user)
  if (res.status === 'ok') {
    submitOpen.value = false
    showToast('纠错已提交并关联《' + (docById.value[fDocId.value]?.title || '') + '》，可在「我提交的」中追踪处理状态')
    tab.value = 'mine'
  } else if (res.status === 'duplicate') {
    alert('该文档已有处理中的纠错单，请等待处理或在「全部」中查看。')
  } else if (res.status === 'guest') {
    alert('访客不能提交纠错，请先登录。')
  } else {
    alert('提交失败，请重试。')
  }
}

// ---- 认领 / 取消认领 ----
async function claim(t) {
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await correctionStore.claimTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('认领失败：工单状态已变化，请刷新查看')
  } finally { busyId.value = '' }
}

async function release(t) {
  if (busyId.value) return
  if (!confirm('确定取消认领？纠错单将退回「待认领」。')) return
  busyId.value = t.id
  try {
    const res = await correctionStore.releaseTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('取消认领失败：状态已变化，请刷新查看')
  } finally { busyId.value = '' }
}

// ---- 提交人撤单 ----
async function revoke(t) {
  if (!canRevokeBySubmitter(t, auth.user?.id)) return
  const note = prompt('撤单说明（可选，将展示给团队）：') || ''
  busyId.value = t.id
  try {
    const res = await correctionStore.revokeBySubmitter(t.id, note.trim(), auth.user)
    if (res.status === 'ok') showToast('已撤回该纠错单')
    else alert('撤单失败：仅待认领阶段可由提交人撤回')
  } finally { busyId.value = '' }
}

// ---- 编辑者退回（问题不成立）----
function openDismiss(t) {
  dismissing.value = { ...dismissing.value, [t.id]: true }
  dismissNote.value = { ...dismissNote.value, [t.id]: '' }
}
async function dismiss(t) {
  const note = (dismissNote.value[t.id] || '').trim()
  if (!note) { alert('请填写退回说明，提交人会看到该原因'); return }
  busyId.value = t.id
  try {
    const res = await correctionStore.dismissByEditor(t.id, note, auth.user)
    if (res.status === 'ok') { dismissing.value = { ...dismissing.value, [t.id]: false }; showToast('已退回，纠错单关闭并通知提交人') }
    else alert('退回失败：状态已变化，请刷新查看')
  } finally { busyId.value = '' }
}

// ---- 修订送审 ----
function toggleEdit(t) {
  const open = !editing.value[t.id]
  editing.value = { ...editing.value, [t.id]: open }
  if (open) {
    const d = docById.value[t.docId]
    revBody.value = { ...revBody.value, [t.id]: d?.body || '' }
    revNote.value = { ...revNote.value, [t.id]: '' }
  }
}

async function submitReview(t) {
  const d = docById.value[t.docId]
  if (!d) { alert('关联文档不存在或已删除'); return }
  const body = revBody.value[t.id] ?? d.body
  if (!String(body).replace(/<[^>]+>/g, '').trim()) { alert('修订正文不能为空'); return }
  busyId.value = t.id
  try {
    const res = await reviewStore.submitCorrectionReview(t.id, {
      title: d.title, body, categoryId: d.categoryId,
      tagIds: d.tagIds || [], visibility: d.visibility
    }, (revNote.value[t.id] || '').trim() || ('纠错修订：' + t.summary), auth.user)
    if (res.status === 'ok') {
      editing.value = { ...editing.value, [t.id]: false }
      showToast('修订已送审，管理员审批通过后将回写版本并恢复问答引用')
    } else if (res.status === 'duplicate') alert('该文档已有流转中的评审单，请等待审批完成。')
    else if (res.status === 'denied' || res.status === 'guest') alert('你没有该文档的修订送审权限。')
    else if (res.status === 'ticket-changed') alert('纠错单状态已变化，请刷新查看。')
    else alert('送审失败：状态已变化，请刷新后重试。')
  } finally { busyId.value = '' }
}

onMounted(async () => {
  await Promise.all([correctionStore.loadAll(), reviewStore.loadAll()])
  if (route.query.doc) openSubmit(String(route.query.doc))
})
</script>

<template>
  <div class="cor-page">
    <header class="head">
      <div class="head-row">
        <h2>🩹 知识纠错处置</h2>
        <button v-if="auth.user" class="btn primary" @click="openSubmit()">＋ 提交纠错</button>
      </div>
      <p class="sub">成员发现错误并<strong>关联文档</strong>提交 → 编辑者认领<strong>修订</strong> → 管理员<strong>审批</strong> → 通过后回写版本并恢复<strong>问答引用</strong>；驳回退回修订，提交人可在「我提交的」全程追踪，异常时可撤单/退回。</p>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }} <em>{{ counts[t.key] || 0 }}</em>
        </button>
      </div>
    </header>

    <div v-if="toast" class="card toast-line">✅ {{ toast }}</div>

    <div v-if="!rows.length" class="empty card">
      <div class="ico">🩺</div>
      {{ emptyText }}
    </div>

    <div v-else class="tk-list">
      <div v-for="t in rows" :key="t.id" class="tk card" :class="{ mine: t.submittedBy === auth.user?.id }">
        <div class="tk-top">
          <div class="tk-q">
            <span class="type-tag">{{ correctionTypeLabel(t.type) }}</span>
            <span class="sum">{{ t.summary || '（未填写错误描述）' }}</span>
            <em v-if="t.submittedBy === auth.user?.id" class="mine-tag">我提交的</em>
          </div>
          <div class="tk-side">
            <span class="st" :class="correctionStatusCls(t.status)">{{ correctionStatusLabel(t.status) }}</span>
            <span class="tk-time">{{ formatDate(t.createdAt) }}</span>
          </div>
        </div>

        <div v-if="t.detail" class="tk-detail"><span class="dl-k">错误说明：</span>{{ t.detail }}</div>
        <div v-if="t.expected" class="tk-detail expect"><span class="dl-k">期望修正：</span>{{ t.expected }}</div>
        <div v-if="t.closeNote" class="tk-close">📝 {{ t.closeNote }}</div>

        <!-- 关联文档 -->
        <div class="linked-doc">
          <span class="lk-label">关联文档：</span>
          <template v-if="docById[t.docId]">
            <span v-if="canView(docById[t.docId])" class="lk-title" @click="router.push('/docs/' + t.docId)">《{{ docById[t.docId].title }}》</span>
            <span v-else class="lk-locked">《无权查看的受限文档》</span>
            <DocPill v-if="canView(docById[t.docId])" :doc="docById[t.docId]" />
          </template>
          <span v-else class="lk-missing">文档已删除</span>
          <span v-if="t.status === 'resolved' && t.resolvedVersion" class="ver-tag">已回写 v{{ t.resolvedVersion }}</span>
        </div>

        <div class="tk-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.submittedBy) }">{{ userById[t.submittedBy]?.avatar || '?' }}</span>
            {{ userById[t.submittedBy]?.name || t.submittedBy }} 提交
          </span>
          <span v-if="t.claimedBy" class="who">修订：<b>{{ userById[t.claimedBy]?.name || t.claimedBy }}</b></span>
          <span v-else-if="t.status === 'open'" class="who none">等待编辑者认领</span>
          <span v-if="t.resolvedAt" class="resolved-at">已于 {{ formatFull(t.resolvedAt) }} 修正发布</span>
        </div>

        <!-- 操作区 -->
        <!-- 待认领 -->
        <div v-if="canClaimCorrection(auth.user?.role, t)" class="acts">
          <button class="btn sm primary" :disabled="busyId === t.id" @click="claim(t)">🙋 认领修订</button>
          <button v-if="canRevokeBySubmitter(t, auth.user?.id)" class="btn sm ghost" :disabled="busyId === t.id" @click="revoke(t)">撤单</button>
        </div>
        <div v-else-if="canRevokeBySubmitter(t, auth.user?.id)" class="acts">
          <button class="btn sm ghost" :disabled="busyId === t.id" @click="revoke(t)">撤单</button>
        </div>

        <!-- 修订中：处理人可修订送审 / 退回 / 取消认领 -->
        <div v-if="canSubmitCorrectionReview(auth.user?.role, t, auth.user?.id)" class="revise-box">
          <div v-if="!editing[t.id]" class="revise-acts">
            <button class="btn sm primary" @click="toggleEdit(t)">✎ 修订并送审</button>
            <button class="btn sm" @click="openDismiss(t)">问题不成立 · 退回</button>
            <button class="btn sm ghost" :disabled="busyId === t.id" @click="release(t)">取消认领</button>
          </div>

          <div v-if="dismissing[t.id]" class="dismiss-form">
            <textarea v-model="dismissNote[t.id]" rows="2" placeholder="退回说明（必填）：为什么该问题不成立或无需修订？提交人会收到该说明"></textarea>
            <div class="df-acts">
              <button class="btn sm" :disabled="busyId === t.id" @click="dismiss(t)">确认退回</button>
              <button class="btn sm ghost" @click="dismissing = { ...dismissing, [t.id]: false }">取消</button>
            </div>
          </div>

          <div v-if="editing[t.id]" class="edit-form">
            <div class="ef-label">修订正文（标题/分类/可见性沿用文档当前值，正文修改随评审审批后回写）：</div>
            <RichEditor v-model="revBody[t.id]" />
            <input v-model="revNote[t.id]" class="ef-note" placeholder="送审说明（可选，将作为评审意见留痕）" />
            <div class="ef-acts">
              <button class="btn sm primary" :disabled="busyId === t.id" @click="submitReview(t)">📤 提交修订送审</button>
              <button class="btn sm ghost" @click="toggleEdit(t)">取消</button>
            </div>
          </div>
        </div>

        <!-- 其他成员视角：修订中 -->
        <div v-else-if="t.status === 'claimed'" class="state-tip">
          🖊 {{ t.claimedBy ? (userById[t.claimedBy]?.name || '处理人') : '' }} 正在核对修订…
          <span v-if="t.submittedBy === auth.user?.id" class="track-hint">提交人可在本页持续追踪，处理完成后状态会自动更新</span>
        </div>

        <!-- 送审中 -->
        <div v-if="t.status === 'in_review'" class="state-tip review-tip">
          ⏳ 修订已送审，等待管理员审批<template v-if="reviewOf(t)">（评审单{{ reviewStatusLabel(reviewOf(t).status) }}）</template>。
          <a v-if="canView(docById[t.docId])" @click="router.push('/docs/' + t.docId)">查看评审进度 →</a>
          <span v-if="reviewOf(t) && reviewOf(t).submittedBy === auth.user?.id" class="track-hint">审批期间问答引用暂停，通过后自动恢复</span>
        </div>

        <!-- 已修正：问答引用已恢复 -->
        <div v-if="t.status === 'resolved'" class="resolved-tip">
          ✅ 修订已审批通过并回写为 v{{ t.resolvedVersion || '?' }}，问答引用已指向修正后的内容。
          <a v-if="canView(docById[t.docId])" @click="router.push('/docs/' + t.docId)">查看文档 →</a>
        </div>

        <details class="timeline">
          <summary>处理记录（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(e, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ correctionTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <!-- 提交纠错弹窗 -->
    <div v-if="submitOpen" class="modal-mask" @click.self="submitOpen = false">
      <div class="modal card">
        <div class="m-head">
          <h3>🩹 提交知识纠错</h3>
          <button class="btn xs ghost" @click="submitOpen = false">✕</button>
        </div>
        <div class="m-body">
          <label class="fld">
            <span class="f-k">关联文档 <em>*</em></span>
            <select v-model="fDocId">
              <option value="" disabled>选择有错误的文档…</option>
              <option v-for="d in linkableDocs" :key="d.id" :value="d.id">{{ d.title }}</option>
            </select>
          </label>
          <label class="fld">
            <span class="f-k">错误类型</span>
            <select v-model="fType">
              <option v-for="ty in CORRECTION_TYPES" :key="ty.key" :value="ty.key">{{ ty.label }}</option>
            </select>
          </label>
          <label class="fld">
            <span class="f-k">错误点摘要 <em>*</em></span>
            <input v-model="fSummary" maxlength="80" placeholder="一句话说明哪里错了，如：登录 Token 有效期写成了 7 天" />
          </label>
          <label class="fld">
            <span class="f-k">详细说明</span>
            <textarea v-model="fDetail" rows="3" placeholder="原文内容、错误位置、为什么是错的…"></textarea>
          </label>
          <label class="fld">
            <span class="f-k">期望的修正</span>
            <textarea v-model="fExpected" rows="2" placeholder="你认为正确的内容或参考依据（可选）"></textarea>
          </label>
          <div class="f-hint">提交后文档进入纠错流程，处理期间暂停问答引用；修订经管理员审批通过后回写版本并恢复引用，你可在「我提交的」中追踪全程状态。</div>
        </div>
        <div class="m-foot">
          <button class="btn ghost" @click="submitOpen = false">取消</button>
          <button class="btn primary" @click="submitCorrection">提交纠错</button>
        </div>
      </div>
    </div>

    <p v-if="!auth.user" class="foot-tip">访客不可提交纠错，请先在「账号与权限」中登录。</p>
  </div>
</template>

<style scoped>
.cor-page { max-width: 900px; margin: 0 auto; padding-bottom: 60px; }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; }
.sub { color: var(--text-2); font-size: 13px; margin: 6px 0 14px; }
.sub strong { color: #c026d3; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 15px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: #c026d3; border-color: #c026d3; color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.toast-line { margin-top: 14px; padding: 10px 18px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk.mine { border-color: #e9d5ff; box-shadow: 0 0 0 1px #f3e8ff; }
.tk-top { display: flex; justify-content: space-between; gap: 14px; }
.tk-q { font-weight: 700; font-size: 15px; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.type-tag { font-size: 11px; font-weight: 600; color: #c026d3; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 6px; padding: 1px 8px; }
.mine-tag { font-style: normal; font-size: 11px; font-weight: 600; color: var(--primary); background: var(--primary-weak); border-radius: 4px; padding: 1px 6px; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.st-revoked { background: var(--panel-2); color: var(--text-3); }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-detail { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.tk-detail.expect { background: #f0fdf4; color: #15803d; }
.dl-k { color: var(--text-3); font-weight: 600; margin-right: 4px; }
.tk-close { margin-top: 8px; font-size: 13px; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 12px; }
.linked-doc { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.lk-label { color: var(--text-3); }
.lk-title { color: var(--primary); font-weight: 600; cursor: pointer; }
.lk-title:hover { text-decoration: underline; }
.lk-locked { color: var(--text-3); }
.lk-missing { color: var(--text-3); }
.ver-tag { font-size: 11px; font-weight: 600; color: #15803d; background: #dcfce7; border-radius: 999px; padding: 1px 9px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.who.none { color: var(--text-3); }
.who b { color: var(--text); }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.resolved-at { font-size: 12px; color: var(--text-3); }
.acts { margin-top: 12px; display: flex; gap: 8px; }
.revise-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.revise-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.state-tip { margin-top: 12px; font-size: 13px; color: var(--text-2); display: flex; flex-direction: column; gap: 3px; }
.state-tip a { cursor: pointer; color: var(--primary); }
.review-tip { flex-direction: row; gap: 8px; flex-wrap: wrap; align-items: center; }
.track-hint { color: var(--text-3); font-size: 12px; }
.resolved-tip { margin-top: 12px; font-size: 13px; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 9px 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.resolved-tip a { cursor: pointer; font-weight: 600; }
.dismiss-form, .edit-form { margin-top: 10px; }
.dismiss-form textarea, .ef-note { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; outline: none; }
.dismiss-form textarea:focus, .ef-note:focus { border-color: var(--primary); }
.df-acts, .ef-acts { display: flex; gap: 8px; margin-top: 8px; }
.ef-label { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.ef-note { margin-top: 8px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: #c026d3; min-width: 170px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
.btn.xs { padding: 3px 10px; font-size: 12px; }

/* 弹窗 */
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: grid; place-items: center; z-index: 100; padding: 20px; }
.modal { width: 560px; max-width: 100%; max-height: 90vh; overflow: auto; padding: 0; }
.m-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.m-head h3 { margin: 0; font-size: 16px; }
.m-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
.fld { display: flex; flex-direction: column; gap: 6px; }
.f-k { font-size: 13px; font-weight: 600; color: var(--text-2); }
.f-k em { color: var(--danger); font-style: normal; }
.fld select, .fld input, .fld textarea { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; outline: none; background: var(--panel); color: var(--text); }
.fld select:focus, .fld input:focus, .fld textarea:focus { border-color: var(--primary); }
.f-hint { font-size: 12px; color: var(--text-3); line-height: 1.6; }
.m-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border); }
</style>
