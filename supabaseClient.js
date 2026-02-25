// SUPABASE CLIENT (Browser-only, ESM via CDN)
// Este módulo fornece integração simples com Supabase usando apenas HTML/JS no navegador.
// Requisitos atendidos:
// - Usa Supabase JS v2 via CDN (ESM)
// - Compatível com HTML puro (sem Node.js/backend)
// - Funções: initSupabase, loadData, saveData(state)
// - Tabela alvo: app_data (colunas esperadas: id TEXT PK, data JSONB)

async function resolveCreateClient() {
  if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
    return window.supabase.createClient
  }
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2')
    return mod.createClient
  } catch {
    return null
  }
}

// Instância compartilhada do cliente Supabase
let supabaseClient = null
// Timer de backup automático
let autoBackupTimer = null
// Último estado conhecido (para uso pelo backup automático)
let lastSavedState = null

// Obtém credenciais guardadas em localStorage, se existirem
function getStoredCreds() {
  try {
    const url = localStorage.getItem('pdv_supabase_url') || ''
    const key = localStorage.getItem('pdv_supabase_anon_key') || ''
    return { url, key }
  } catch {
    return { url: '', key: '' }
  }
}

// Salva credenciais em localStorage (útil para persistir no navegador)
function setStoredCreds(url, key) {
  try {
    localStorage.setItem('pdv_supabase_url', url || '')
    localStorage.setItem('pdv_supabase_anon_key', key || '')
  } catch {}
}

// initSupabase({ url, key })
// - Inicializa o cliente Supabase para uso nas demais funções
// - Se url/key não forem informados, tenta buscar de localStorage
// - Observação de segurança: use SEMPRE a chave pública (anon) com RLS habilitado
export function initSupabase({ url, key } = {}) {
  // Permite configurar via variáveis globais se desejado
  const fallbackUrl = (typeof window !== 'undefined' && window.SUPABASE_URL) || ''
  const fallbackKey = (typeof window !== 'undefined' && window.SUPABASE_ANON_KEY) || ''

  // Tenta credenciais fornecidas → localStorage → variáveis globais
  let supaUrl = url || getStoredCreds().url || fallbackUrl
  let supaKey = key || getStoredCreds().key || fallbackKey

  if (!supaUrl || !supaKey) {
    throw new Error('Configuração do Supabase ausente. Informe url e anon key.')
  }

  // Persiste para próximos usos
  setStoredCreds(supaUrl, supaKey)

  return (async () => {
    const createClientFn = await resolveCreateClient()
    if (!createClientFn) {
      throw new Error('Biblioteca Supabase não carregada')
    }
    supabaseClient = createClientFn(supaUrl, supaKey)
    return supabaseClient
  })()
}

// createBackup(state)
// - Salva o estado atual na tabela "app_backups"
// - Em caso de indisponibilidade, não quebra a aplicação (retorna false)
export async function createBackup(state) {
  if (!supabaseClient) {
    console.warn('Supabase não inicializado; backup não executado.')
    return false
  }
  try {
    const payload = { data: state }
    const { error } = await supabaseClient
      .from('app_backups')
      .insert(payload)
    if (error) {
      console.warn('Falha ao criar backup (offline/RLS?):', error.message)
      return false
    }
    return true
  } catch (e) {
    console.warn('Erro ao criar backup:', e?.message || e)
    return false
  }
}

// loadData()
// - Busca o primeiro registro da tabela "app_data"
// - Retorna o conteúdo do campo JSON (coluna "data")
// - Se não existir, retorna null
export async function loadData() {
  if (!supabaseClient) {
    throw new Error('Supabase não inicializado. Chame initSupabase primeiro.')
  }
  // Seleciona o primeiro registro; maybeSingle retorna null quando não há linhas
  const { data, error } = await supabaseClient
    .from('app_data')
    .select('*')
    .limit(1)
    .maybeSingle()

  if (error) {
    // Em produção você pode logar ou tratar de forma diferente
    console.error('Erro ao carregar dados do Supabase:', error)
    throw error
  }
  if (!data) return null
  // Retorna o campo JSON (assumimos coluna "data" do tipo JSONB)
  return data.data ?? null
}

// saveData(state)
// - Faz upsert com id fixo "global_state" na tabela "app_data"
// - Salva o objeto inteiro no campo JSON "data"
// - Exige RLS configurado para permitir upsert com a anon key
export async function saveData(state) {
  if (!supabaseClient) {
    throw new Error('Supabase não inicializado. Chame initSupabase primeiro.')
  }
  // Guarda o último estado conhecido (para auto-backup)
  lastSavedState = state
  // Garante backup prévio; não bloqueia em caso de erro/offline
  try { await createBackup(state) } catch {}
  const payload = { id: 'global_state', data: state }
  const { error } = await supabaseClient
    .from('app_data')
    .upsert(payload, { onConflict: 'id' })

  if (error) {
    console.error('Erro ao salvar dados no Supabase:', error)
    throw error
  }
  return true
}

// listBackups()
// - Retorna todos os backups ordenados por created_at DESC
// - Em caso de erro, retorna []
export async function listBackups() {
  if (!supabaseClient) {
    console.warn('Supabase não inicializado; listBackups retorna [].')
    return []
  }
  try {
    const { data, error } = await supabaseClient
      .from('app_backups')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      console.warn('Falha ao listar backups:', error.message)
      return []
    }
    return data || []
  } catch (e) {
    console.warn('Erro ao listar backups:', e?.message || e)
    return []
  }
}

// startAutoBackup(intervalMinutes)
// - Inicia um setInterval que chama createBackup() a cada N minutos
// - Obtém o estado de window.getFullState() quando disponível
// - Caso contrário, usa lastSavedState
export function startAutoBackup(intervalMinutes) {
  if (autoBackupTimer) {
    try { clearInterval(autoBackupTimer) } catch {}
    autoBackupTimer = null
  }
  const ms = Math.max(1, parseInt(intervalMinutes || '1')) * 60 * 1000
  autoBackupTimer = setInterval(async () => {
    try {
      let state = null
      if (typeof window !== 'undefined' && typeof window.getFullState === 'function') {
        try { state = window.getFullState() } catch {}
      }
      if (!state) state = lastSavedState
      if (!state) {
        console.warn('Sem estado para backup automático; salte esta execução.')
        return
      }
      await createBackup(state)
    } catch (e) {
      console.warn('Backup automático falhou:', e?.message || e)
    }
  }, ms)
  return autoBackupTimer
}

// restoreBackup(backupId)
// - Busca o backup pelo id e sobrescreve a tabela principal com aquele estado
// - Usa upsert na "app_data" com id "global_state"
export async function restoreBackup(backupId) {
  if (!supabaseClient) {
    throw new Error('Supabase não inicializado. Chame initSupabase primeiro.')
  }
  try {
    const { data, error } = await supabaseClient
      .from('app_backups')
      .select('*')
      .eq('id', backupId)
      .maybeSingle()
    if (error) {
      console.error('Erro ao buscar backup:', error.message)
      throw error
    }
    if (!data) {
      console.warn('Backup não encontrado para id:', backupId)
      return false
    }
    const state = data.data
    const { error: upErr } = await supabaseClient
      .from('app_data')
      .upsert({ id: 'global_state', data: state }, { onConflict: 'id' })
    if (upErr) {
      console.error('Erro ao restaurar estado principal:', upErr.message)
      throw upErr
    }
    // Atualiza cache local
    lastSavedState = state
    return true
  } catch (e) {
    console.error('Falha ao restaurar backup:', e?.message || e)
    return false
  }
}

// Expõe um namespace global para facilitar uso em HTML puro:
// Ex.: SupaSync.initSupabase({ url:'...', key:'...' })
//      const state = await SupaSync.loadData()
//      await SupaSync.saveData(stateAtualizado)
if (typeof window !== 'undefined') {
  window.SupaSync = { initSupabase, loadData, saveData, createBackup, startAutoBackup, listBackups, restoreBackup }
}
