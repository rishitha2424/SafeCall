import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

export class CloudStorageService {
  private client: SupabaseClient | null = null;
  private bucketName: string;
  private isEnabled: boolean = false;

  constructor() {
    this.bucketName = config.cloudStorage.supabaseBucket || 'safefamily';
    this.initClient();
  }

  private initClient(): void {
    if (config.cloudStorage.isConfigured) {
      try {
        this.client = createClient(
          config.cloudStorage.supabaseUrl,
          config.cloudStorage.supabaseKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
            },
          }
        );
        this.isEnabled = true;
        console.log(`[CloudStorage] Supabase Storage client initialized for bucket: '${this.bucketName}'`);
      } catch (err: any) {
        console.error('[CloudStorage] Failed to initialize Supabase client:', err.message);
        this.client = null;
        this.isEnabled = false;
      }
    } else {
      console.log('[CloudStorage] Cloud sync is not configured (SUPABASE_URL/KEY missing). Operating with local filesystem.');
    }
  }

  public isConfigured(): boolean {
    return this.isEnabled && this.client !== null;
  }

  public getStatus() {
    return {
      configured: this.isConfigured(),
      provider: 'Supabase Storage',
      bucket: this.bucketName,
      url: config.cloudStorage.supabaseUrl ? config.cloudStorage.supabaseUrl.replace(/^(https?:\/\/[^.]+).*/, '$1.supabase.co') : null,
    };
  }

  /**
   * Ensure bucket exists (attempt creation if service role permissions allow)
   */
  private async ensureBucket(): Promise<void> {
    if (!this.client) return;
    try {
      const { data: buckets } = await this.client.storage.listBuckets();
      const exists = buckets?.some((b) => b.name === this.bucketName);
      if (!exists) {
        await this.client.storage.createBucket(this.bucketName, {
          public: false,
          fileSizeLimit: 10485760, // 10MB
        });
        console.log(`[CloudStorage] Created storage bucket '${this.bucketName}'`);
      }
    } catch {
      // Ignore if insufficient permissions to list/create buckets; user can create bucket in dashboard
    }
  }

  /**
   * Download the latest workbook from cloud storage to local disk.
   * Returns true if file was downloaded, false otherwise.
   */
  public async downloadWorkbook(targetFilePath: string): Promise<boolean> {
    if (!this.isConfigured() || !this.client) return false;

    const fileName = path.basename(targetFilePath);
    try {
      console.log(`[CloudStorage] Checking remote storage for latest '${fileName}'...`);
      const { data, error } = await this.client.storage
        .from(this.bucketName)
        .download(fileName);

      if (error || !data) {
        console.log(`[CloudStorage] No remote file found or download notice: ${error?.message || 'Empty file'}`);
        return false;
      }

      const arrayBuffer = await data.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        return false;
      }

      const buffer = Buffer.from(arrayBuffer);
      // Ensure target directory exists
      const targetDir = path.dirname(targetFilePath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      await fs.promises.writeFile(targetFilePath, buffer);
      console.log(
        `[CloudStorage] ✅ Restored latest workbook (${(buffer.length / 1024).toFixed(1)} KB) from '${this.bucketName}/${fileName}'`
      );
      return true;
    } catch (err: any) {
      console.warn(`[CloudStorage] Notice: Could not download remote workbook: ${err.message}`);
      return false;
    }
  }

  /**
   * Upload the updated local workbook to cloud storage.
   */
  public async uploadWorkbook(sourceFilePath: string): Promise<boolean> {
    if (!this.isConfigured() || !this.client) return false;

    const fileName = path.basename(sourceFilePath);
    try {
      if (!fs.existsSync(sourceFilePath)) {
        console.warn(`[CloudStorage] Source file not found: ${sourceFilePath}`);
        return false;
      }

      await this.ensureBucket();

      const fileBuffer = await fs.promises.readFile(sourceFilePath);
      const { error } = await this.client.storage
        .from(this.bucketName)
        .upload(fileName, fileBuffer, {
          upsert: true,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });

      if (error) {
        console.error(`[CloudStorage] ❌ Upload failed for '${fileName}':`, error.message);
        return false;
      }

      console.log(
        `[CloudStorage] ☁️ Successfully synced updated workbook (${(fileBuffer.length / 1024).toFixed(1)} KB) to '${this.bucketName}/${fileName}'`
      );
      return true;
    } catch (err: any) {
      console.error(`[CloudStorage] ❌ Sync exception for '${fileName}':`, err.message);
      return false;
    }
  }
}

export const cloudStorage = new CloudStorageService();
