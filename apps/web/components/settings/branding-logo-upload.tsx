'use client'

import * as React from 'react'
import { Upload, X, Loader2 } from 'lucide-react'
import { getAccessToken } from '@/lib/auth'
import { Button } from '@/components/ui/button'

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api'

interface BrandingLogoUploadProps {
  slotKey: string
  label: string
  description: string
  acceptedFormats: string[]
  minResolution: string
  guidance: string
  currentUrl: string | null
  defaultUrl?: string
  previewBg?: string
  disabled?: boolean
  onUpload: (url: string, key: string) => void
  onRemove: () => void
}

export function BrandingLogoUpload({
  slotKey,
  label,
  description,
  acceptedFormats,
  minResolution,
  guidance,
  currentUrl,
  defaultUrl,
  previewBg = 'bg-zinc-900',
  disabled,
  onUpload,
  onRemove,
}: BrandingLogoUploadProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    setError(null)

    if (file.size > 2 * 1024 * 1024) {
      setError('File must be under 2 MB')
      return
    }

    const token = getAccessToken()
    setUploading(true)
    try {
      // Step 1: Get presigned URL
      const uploadKey = slotKey.replace(/_/g, '-')
      const mimeType = encodeURIComponent(file.type || 'image/png')
      const presignRes = await fetch(`${API_URL}/instance/branding/${uploadKey}-upload?content_type=${mimeType}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!presignRes.ok) {
        const errData = await presignRes.json().catch(() => ({}))
        throw new Error(errData.detail || 'Failed to get upload URL')
      }
      const { upload_url: presignedUrl, key: s3Key } = await presignRes.json()

      // Step 2: Upload to S3 via nginx proxy
      const uploadRes = await fetch(presignedUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      })
      if (!uploadRes.ok) throw new Error('Failed to upload file')

      // Step 3: Update branding with new key
      const updateBody: Record<string, string> = {}
      updateBody[`${slotKey}_key`] = s3Key
      const updateRes = await fetch(`${API_URL}/instance/branding`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(updateBody),
      })
      if (!updateRes.ok) {
        const errData = await updateRes.json().catch(() => ({}))
        throw new Error(errData.detail || 'Failed to save branding')
      }
      const updated: { logo_light_url?: string; logo_dark_url?: string; favicon_url?: string; apple_icon_url?: string; login_logo_url?: string } = await updateRes.json()

      // Extract the URL
      const urlKey = `${slotKey}_url`
      const logoUrl = updated[urlKey as keyof typeof updated] || null
      if (logoUrl) {
        onUpload(logoUrl, s3Key)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove() {
    setError(null)
    const token = getAccessToken()
    const type = slotKey.replace('logo_', '').replace('login_', 'login-').replace('_', '-')
    try {
      const res = await fetch(`${API_URL}/instance/branding/logo/${type}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('Failed to reset logo')
      onRemove()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    }
  }

  const acceptString = acceptedFormats.join(',')
  const hasLogo = !!currentUrl

  return (
    <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-bg-secondary">
      <div
        className={`h-16 w-16 rounded-xl border border-border flex items-center justify-center overflow-hidden shrink-0 ${previewBg}`}
      >
        {currentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentUrl} alt={label} className="h-full w-full object-contain p-1" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={defaultUrl || `/logo-icon.svg`}
            alt="Default"
            className="h-full w-full object-contain p-1 opacity-40"
          />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-secondary">{label}</p>
        <p className="text-sm text-text-secondary mt-0.5 mb-3">{description}</p>

        {error && (
          <p className="text-xs text-status-error mb-2">{error}</p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptString}
            className="hidden"
            onChange={handleFile}
            disabled={disabled || uploading}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {hasLogo ? 'Replace' : 'Upload'}
          </Button>
          {hasLogo && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={uploading}
              className="text-status-error hover:text-status-error hover:bg-status-error/10"
            >
              <X className="h-3.5 w-3.5" />
              Remove
            </Button>
          )}
        </div>

        <p className="text-xs text-text-secondary mt-2">
          {acceptedFormats.join(', ')} · {minResolution} · Max 2 MB
        </p>
        {guidance && (
          <p className="text-xs text-text-secondary mt-0.5 italic">{guidance}</p>
        )}
      </div>
    </div>
  )
}
