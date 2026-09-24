<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useCorrectionStore } from '@/stores/correction'
import { formatFull, avatarColor } from '@/utils/format'
import {
  CORRECTION_TYPES, correctionTypeLabel, correctionStatusLabel,
  correctionStatusCls, correctionTimelineLabel, canCreateCorrection
} from '@/utils/correction'

const props = defineProps({
  doc: { type: Object, required: true }
})

const router = useRouter()
const auth = useAuthStore()
const correctionStore = useCorrectionStore()

const open = ref(false)
const busy = ref(false)
const fType = ref('factual')
const fSummary = ref('')
const fDetail = ref('')
const fExpected = ref('')

const tickets = computed(() => correctionStore.ticketsOfDoc(props.doc.id))
const active = computed(() => correctionStore.activeTicketOfDoc(props.doc.id))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const canSubmit = computed(() => canCreateCorrection(auth.user) && !active.value && !(props.doc.retirement && props.doc.retirement.status === 'approved'))

async function submit() {
  if (!fSummary.value.trim()) { alert('请简要描述错误点'); return }
  busy.value = true
  try {
    const res = await correctionStore.createTicket({
      docId: props.doc.id, type: fType.value,
      summary: fSummary.value, detail: fDetail.value, expected: fExpected.value
    }, auth.user)
    if (res.status === 'ok') {
      open.value = false
      fSummary.value = ''; fDetail.value = ''; fExpected.value = ''
    } else if (res.status === 'duplicate') {
      alert('该文档已有处理中的纠错单。')
      open.value = false
    } else if (res.status === 'guest') {
      alert('访客不能提交纠错，请先登录。')
    }
  } finally { busy.value = false }
}
</script>

<template>
  <div class="cor-panel card">
    <div class="cp-head">
      <span class="cp-title">🩹 知识纠错</span>
      <span v-if="active" class="st" :class="correctionStatusCls(active.status)">{{ correctionStatusLabel(active.status) }}</span>
      <button v-if="canSubmit" class="btn sm primary" @click="open = !open">＋ 提交纠错</button>
      <button v-else-if="active" class="btn sm ghost" @click="router.push('/corrections')">前往纠错中心</button>
    </div>

    <!-- 流转中的纠错单：提示问答引用已暂停 -->
    <div v-if="active" class="cp-active">
      <div class="ca-line">
        <span class="type-tag">{{ correctionTypeLabel(active.type) }}</span>
        <b>{{ active.summary }}</b>
      </div>
      <div v-if="active.detail" class="ca-detail">{{ active.detail }}</div>
      <div class="ca-meta">
        <span class="who">
          <span class="ava" :style="{ background: avatarColor(active.submittedBy) }">{{ userById[active.submittedBy]?.avatar || '?' }}</span>
          {{ userById[active.submittedBy]?.name || active.submittedBy }} 提交
        </span>
        <span v-if="active.claimedBy">修订：{{ userById[active.claimedBy]?.name || active.claimedBy }}</span>
        <span v-if="active.status === 'resolved'">已回写 v{{ active.resolvedVersion }}</span>
      </div>
      <div class="ca-cite-tip">处理期间本文档问答引用已暂停，修订经管理员审批通过回写版本后自动恢复。</div>
    </div>

    <!-- 提交表单 -->
    <div v-if="open" class="cp-form">
      <select v-model="fType">
        <option v-for="ty in CORRECTION_TYPES" :key="ty.key" :value="ty.key">{{ ty.label }}</option>
      </select>
      <input v-model="fSummary" maxlength="80" placeholder="错误点摘要（必填），如：Token 有效期写成了 7 天" />
      <textarea v-model="fDetail" rows="3" placeholder="错误位置、原文内容、为什么是错的…"></textarea>
      <textarea v-model="fExpected" rows="2" placeholder="期望的修正 / 参考依据（可选）"></textarea>
      <div class="cp-acts">
        <button class="btn sm primary" :disabled="busy" @click="submit">提交纠错</button>
        <button class="btn sm ghost" @click="open = false">取消</button>
      </div>
      <div class="cp-hint">提交后进入「待认领 → 修订 → 审批」闭环，处理期间暂停问答引用，通过后回写版本并恢复引用。</div>
    </div>

    <!-- 历史纠错单（最近 3 条） -->
    <details v-if="tickets.length" class="cp-history">
      <summary>本文档纠错记录（{{ tickets.length }}）</summary>
      <div v-for="t in tickets.slice(0, 5)" :key="t.id" class="hi">
        <div class="hi-top">
          <span class="type-tag">{{ correctionTypeLabel(t.type) }}</span>
          <span class="hi-sum">{{ t.summary }}</span>
          <span class="st" :class="correctionStatusCls(t.status)">{{ correctionStatusLabel(t.status) }}</span>
        </div>
        <div class="hi-meta">
          {{ userById[t.submittedBy]?.name || t.submittedBy }} 提交 · {{ formatFull(t.createdAt) }}
          <span v-if="t.resolvedVersion"> · 已回写 v{{ t.resolvedVersion }}</span>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.cor-panel { margin-top: 14px; padding: 16px 20px; }
.cp-head { display: flex; align-items: center; gap: 10px; }
.cp-title { font-weight: 700; font-size: 14px; }
.cp-head .st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-in_review, .st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.st-revoked { background: var(--panel-2); color: var(--text-3); }
.cp-head .btn { margin-left: auto; }
.cp-active { margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: #faf5ff; border: 1px solid #e9d5ff; }
.ca-line { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.type-tag { font-size: 11px; font-weight: 600; color: #c026d3; background: #fff; border: 1px solid #e9d5ff; border-radius: 6px; padding: 1px 8px; }
.ca-detail { margin-top: 6px; font-size: 13px; color: var(--text-2); }
.ca-meta { margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-3); align-items: center; }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.ca-cite-tip { margin-top: 8px; font-size: 12px; color: #a21caf; }
.cp-form { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.cp-form select, .cp-form input, .cp-form textarea { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; outline: none; background: var(--panel); color: var(--text); }
.cp-form select:focus, .cp-form input:focus, .cp-form textarea:focus { border-color: #c026d3; }
.cp-acts { display: flex; gap: 8px; }
.cp-hint { font-size: 12px; color: var(--text-3); }
.cp-history { margin-top: 12px; }
.cp-history summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.hi { padding: 8px 0; border-bottom: 1px dashed var(--border); }
.hi:last-child { border-bottom: none; }
.hi-top { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.hi-sum { flex: 1; min-width: 0; }
.hi-meta { font-size: 12px; color: var(--text-3); margin-top: 3px; }
</style>
