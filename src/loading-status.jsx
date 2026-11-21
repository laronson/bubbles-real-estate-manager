import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from '@ui-sdk/react/progress'

export function LoadingStatus({ children, className }) {
  return (
    <div role="status" className={className}>
      <Progress value={null} className="loading-progress">
        <ProgressLabel>{children}</ProgressLabel>
        <ProgressTrack><ProgressIndicator /></ProgressTrack>
      </Progress>
    </div>
  )
}
