export interface StorageUsage {
  total_bytes:number;
  used_bytes:number;
  available_bytes:number;
  used_percent:number;
  sampled_at:number;
}
export interface ServerBackup {
  job_id:string;created_at:number;bytes:number;sha256:string;filename:string;url:string;
}
