import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="Beklenmeyen bir hata oluştu"
          subTitle={this.state.error.message}
          extra={
            <Button type="primary" onClick={() => { this.setState({ error: null }); window.location.reload() }}>
              Sayfayı Yenile
            </Button>
          }
        />
      )
    }
    return this.props.children
  }
}
