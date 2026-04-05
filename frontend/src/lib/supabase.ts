import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Storage bucket name for file uploads
const BUCKET_NAME = 'osborn-storage'

export interface UploadResult {
  success: boolean
  url?: string
  error?: string
  fileName?: string
  fileType?: string
  size?: number
}

/**
 * Upload a file to Supabase Storage
 */
export async function uploadFile(file: File, folder: string = 'uploads'): Promise<UploadResult> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return { success: false, error: 'Supabase not configured' }
  }

  try {
    // Generate unique filename
    const timestamp = Date.now()
    const randomId = Math.random().toString(36).substring(2, 8)
    const ext = file.name.split('.').pop() || 'bin'
    const fileName = `${folder}/${timestamp}-${randomId}.${ext}`

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
      })

    if (error) {
      console.error('Supabase upload error:', error)
      return { success: false, error: error.message }
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName)

    return {
      success: true,
      url: urlData.publicUrl,
      fileName: file.name,
      fileType: file.type,
      size: file.size,
    }
  } catch (err) {
    console.error('Upload failed:', err)
    return { success: false, error: (err as Error).message }
  }
}

/**
 * Upload multiple files
 */
export async function uploadFiles(files: File[], folder: string = 'uploads'): Promise<UploadResult[]> {
  return Promise.all(files.map(file => uploadFile(file, folder)))
}

/**
 * Delete a file from Supabase Storage
 */
export async function deleteFile(filePath: string): Promise<boolean> {
  try {
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([filePath])

    if (error) {
      console.error('Delete error:', error)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Check if Supabase is properly configured
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey)
}
