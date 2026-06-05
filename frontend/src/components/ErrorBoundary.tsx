import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'
import i18n from '@/i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// LANG-FIX-W1: Class component — useTranslation hook kullanılamaz; i18n
// instance'ın .t() metodu doğrudan çağrılır. Dil değişiminde re-render
// olmaz, ancak ErrorBoundary yalnızca hata anında render edilir; pratikte
// yeterli (kullanıcı sayfayı yenileyince doğru dilde yeniden gelir).
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
          title={i18n.t('error_boundary.title')}
          subTitle={this.state.error.message}
          extra={
            <Button type="primary" onClick={() => { this.setState({ error: null }); window.location.reload() }}>
              {i18n.t('error_boundary.reload')}
            </Button>
          }
        />
      )
    }
    return this.props.children
  }
}
