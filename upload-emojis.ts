/**
 * Uploads all emoji assets from assets/archipelago-icons to the Discord application.
 * Run once after setting up the bot:
 *   npx tsx upload-emojis.ts
 */
import 'dotenv/config'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import axios, { AxiosError } from 'axios'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const ASSETS_DIR = './assets/archipelago-icons'
const API_BASE = 'https://discord.com/api/v10'

if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN not set in .env')
  process.exit(1)
}

// Get application ID from the token (first segment, base64-decoded)
const appId = Buffer.from(TOKEN.split('.')[0], 'base64').toString('utf8')
console.log(`Application ID: ${appId}`)

const headers = {
  Authorization: `Bot ${TOKEN}`,
  'Content-Type': 'application/json',
}

async function sleep (ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function collectPngFiles (dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await collectPngFiles(fullPath))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') {
      results.push(fullPath)
    }
  }
  return results
}

async function fetchExistingEmojis (): Promise<Set<string>> {
  const res = await axios.get(`${API_BASE}/applications/${appId}/emojis`, { headers })
  // Discord may return { items: [...] } or just [...]
  const list: any[] = Array.isArray(res.data) ? res.data : (res.data.items ?? [])
  const names = new Set<string>(list.map((e: any) => e.name as string))
  console.log(`Found ${names.size} existing application emojis`)
  return names
}

async function uploadEmoji (name: string, filePath: string, attempt = 1): Promise<'uploaded' | 'skipped' | 'failed'> {
  const imageData = await readFile(filePath)
  const base64 = imageData.toString('base64')
  const dataUri = `data:image/png;base64,${base64}`

  try {
    await axios.post(
      `${API_BASE}/applications/${appId}/emojis`,
      { name, image: dataUri },
      { headers },
    )
    return 'uploaded'
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status
      const data = err.response?.data

      if (status === 429) {
        const retryAfter = (err.response?.headers['retry-after'] ?? 5) as number
        console.log(`  Rate limited — waiting ${retryAfter}s`)
        await sleep(retryAfter * 1000)
        return uploadEmoji(name, filePath, attempt)
      }

      // Transient errors — retry up to 3 times
      if ((status === 503 || status === 502 || status === 504) && attempt <= 3) {
        console.log(`  Transient ${status} — retrying (attempt ${attempt + 1})`)
        await sleep(2000 * attempt)
        return uploadEmoji(name, filePath, attempt + 1)
      }

      if (status === 400 && data?.code === 30046) {
        console.error('  Hit 2000 emoji limit — stopping')
        process.exit(1)
      }

      // Already exists — treat as a skip
      const alreadyTaken = data?.errors?.name?._errors?.some(
        (e: any) => e.code === 'APPLICATION_EMOJI_NAME_ALREADY_TAKEN',
      )
      if (alreadyTaken) {
        return 'skipped'
      }

      console.error(`  Failed (${status}): ${JSON.stringify(data)}`)
      return 'failed'
    }
    throw err
  }
}

async function main () {
  const allFiles = await collectPngFiles(ASSETS_DIR)
  console.log(`Found ${allFiles.length} PNG files`)

  const existing = await fetchExistingEmojis()

  let uploaded = 0
  let skipped = 0
  let failed = 0
  const seen = new Set<string>()

  for (const filePath of allFiles) {
    const name = basename(filePath, extname(filePath))

    // Discord emoji names: 2-32 chars, alphanumeric + underscores only
    if (name.length < 2 || name.length > 32 || !/^[a-zA-Z0-9_]+$/.test(name)) {
      console.warn(`Skipping invalid emoji name: "${name}" (${filePath})`)
      skipped++
      continue
    }

    // Skip duplicate filenames — first path found wins
    if (seen.has(name)) {
      console.log(`Skipping duplicate: ${name} (${filePath})`)
      skipped++
      continue
    }
    seen.add(name)

    if (existing.has(name)) {
      skipped++
      continue
    }

    process.stdout.write(`Uploading ${name}... `)
    const result = await uploadEmoji(name, filePath)
    if (result === 'uploaded') {
      console.log('✓')
      uploaded++
    } else if (result === 'skipped') {
      console.log('(already exists)')
      skipped++
    } else {
      failed++
    }

    // Stay well within rate limits — Discord allows ~5 req/s on this endpoint
    await sleep(300)
  }

  console.log(`\nDone. Uploaded: ${uploaded}, Skipped: ${skipped}, Failed: ${failed}`)
}

main().catch(e => { console.error(e); process.exit(1) })
