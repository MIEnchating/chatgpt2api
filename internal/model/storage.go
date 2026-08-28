package model

const (
	StorageProviderTypeLocal  = "local"
	StorageProviderTypeS3     = "s3"
	StorageProviderTypeWebDAV = "webdav"
)

// StorageObject is the shared media file index for local, S3/R2, and WebDAV objects.
type StorageObject struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerId"`
	Bucket     string `json:"bucket"`
	ObjectKey  string `json:"objectKey"`
	PublicURL  string `json:"publicUrl"`
	MIMEType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SHA256     string `json:"sha256"`
	Direct     bool   `json:"direct"`
	CreatedBy  string `json:"createdBy"`
	CreatedAt  string `json:"createdAt"`
	DeletedAt  string `json:"deletedAt"`
}

type StorageProvider struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Type              string `json:"type"`
	Endpoint          string `json:"endpoint"`
	Region            string `json:"region"`
	Bucket            string `json:"bucket"`
	AccessKeyID       string `json:"accessKeyId"`
	SecretAccessKey   string `json:"secretAccessKey"`
	PublicBaseURL     string `json:"publicBaseUrl"`
	PathPrefix        string `json:"pathPrefix"`
	Username          string `json:"username"`
	Password          string `json:"password"`
	Weight            int    `json:"weight"`
	Enabled           bool   `json:"enabled"`
	OwnerUserID       string `json:"ownerUserId"`
	CapacityBytes     int64  `json:"capacityBytes"`
	CapacityCheckedAt string `json:"capacityCheckedAt"`
	CapacityExceeded  bool   `json:"capacityExceeded"`
}

type StorageCapacityCheckSetting struct {
	Enabled bool   `json:"enabled"`
	Cron    string `json:"cron"`
}

type StorageSetting struct {
	Mode                    string                      `json:"mode"`
	AllowUserProvider       bool                        `json:"allowUserProvider"`
	AllowUserGlobalProvider bool                        `json:"allowUserGlobalProvider"`
	Providers               []StorageProvider           `json:"providers"`
	RoundRobinCursor        int                         `json:"roundRobinCursor"`
	CapacityCheck           StorageCapacityCheckSetting `json:"capacityCheck"`
	CapacityLimitBytes      int64                       `json:"capacityLimitBytes"`
	LocalCapacityLimitBytes int64                       `json:"localCapacityLimitBytes"`
}
